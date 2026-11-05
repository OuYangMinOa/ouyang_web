//! AI 助手能用的工具：內建的（ai_builtin.rs）加上管理員接的 MCP 伺服器上的（mcp.rs）。
//!
//! - 給模型的名稱：內建的是固定名稱（例如 `calendar_create_event`），MCP 的是 `前綴__工具名稱`。
//! - 管理員可以關掉任何一個工具，或改要不要使用者確認（`ai_tool_settings`），沒設定過就用預設：
//!   內建的會改資料才要確認；MCP 的除非伺服器標明只讀（`readOnlyHint`），不然都要確認。
//! - 沒勾「開放給所有人」的 MCP 伺服器，只有管理員的對話裡有它的工具。

use std::{collections::HashMap, time::Duration};

use axum::{
    Json,
    extract::{Path, State},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::SqlitePool;

use crate::{
    AppError, AppState,
    ai_builtin::{self, Builtin},
    auth::{AdminUsers, CurrentUser, Permission as _, Require},
    mcp::{self, McpTool, Server, ServerView},
};

/// 一個工具最久跑多久
const TOOL_TIMEOUT: Duration = Duration::from_secs(90);
/// 工具結果最多給模型看多少字
const MAX_RESULT_CHARS: usize = 16_000;

#[derive(Clone, Debug)]
pub enum Source {
    Builtin(Builtin),
    Mcp { server: Box<Server>, tool: String },
}

#[derive(Clone, Debug)]
pub struct Tool {
    /// 給模型的名稱
    pub name: String,
    /// 給人看的名稱
    pub title: String,
    pub description: String,
    pub parameters: Value,
    pub source: Source,
    pub enabled: bool,
    /// 執行前要不要使用者確認
    pub approval: bool,
    pub default_approval: bool,
}

impl Tool {
    /// OpenAI 的 `tools` 格式
    pub fn definition(&self) -> Value {
        json!({ "type": "function", "function": {
            "name": self.name,
            "description": self.description,
            "parameters": self.parameters,
        } })
    }

    fn source_label(&self) -> String {
        match &self.source {
            Source::Builtin(_) => "本站".into(),
            Source::Mcp { server, .. } => server.name.clone(),
        }
    }
}

/// MCP 工具給模型的名稱：`前綴__工具`，只留英數字、`_`、`-`，最長 64 字
pub fn mcp_function_name(prefix: &str, tool: &str) -> String {
    let clean: String = tool.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' }).collect();
    format!("{prefix}__{clean}").chars().take(64).collect()
}

#[derive(sqlx::FromRow)]
struct Setting {
    tool: String,
    enabled: bool,
    approval: bool,
}

async fn settings(pool: &SqlitePool) -> Result<HashMap<String, (bool, bool)>, sqlx::Error> {
    let rows: Vec<Setting> =
        sqlx::query_as("SELECT tool, enabled, approval FROM ai_tool_settings").fetch_all(pool).await?;
    Ok(rows.into_iter().map(|s| (s.tool, (s.enabled, s.approval))).collect())
}

/// 所有工具（含關掉的、含只有管理員能用的 MCP），套用管理員的設定
pub async fn all_tools(pool: &SqlitePool) -> Result<(Vec<Tool>, Vec<Server>), sqlx::Error> {
    let settings = settings(pool).await?;
    let apply = |name: &str, default_approval: bool| settings.get(name).copied().unwrap_or((true, default_approval));
    let mut tools: Vec<Tool> = ai_builtin::SPECS
        .iter()
        .map(|spec| {
            let (enabled, approval) = apply(spec.name, spec.writes);
            Tool {
                name: spec.name.into(),
                title: spec.title.into(),
                description: spec.description.into(),
                parameters: (spec.parameters)(),
                source: Source::Builtin(spec.kind),
                enabled,
                approval,
                default_approval: spec.writes,
            }
        })
        .collect();
    let servers = mcp::list_servers(pool).await?;
    for server in &servers {
        for McpTool { name, title, description, input_schema, read_only } in server.tool_list() {
            let function = mcp_function_name(&server.prefix, &name);
            if tools.iter().any(|t| t.name == function) {
                continue;
            }
            let (enabled, approval) = apply(&function, !read_only);
            tools.push(Tool {
                title: title.unwrap_or_else(|| name.clone()),
                description: description.chars().take(1000).collect(),
                parameters: input_schema,
                source: Source::Mcp { server: Box::new(server.clone()), tool: name },
                enabled,
                approval,
                default_approval: !read_only,
                name: function,
            });
        }
    }
    Ok((tools, servers))
}

/// 這個使用者的對話裡可以用的工具
pub async fn available(pool: &SqlitePool, user: &CurrentUser) -> Result<Vec<Tool>, sqlx::Error> {
    let is_admin = user.has(AdminUsers::NAME);
    let (tools, _) = all_tools(pool).await?;
    Ok(tools
        .into_iter()
        .filter(|tool| tool.enabled)
        .filter(|tool| match &tool.source {
            Source::Builtin(_) => true,
            Source::Mcp { server, .. } => server.enabled && (server.public || is_admin),
        })
        .collect())
}

/// 要確認時給使用者看的一句話（內建工具才有）
pub async fn summary(state: &AppState, user: &CurrentUser, tool: &Tool, arguments: &str) -> Option<String> {
    let args: Value = serde_json::from_str(arguments).ok()?;
    match tool.source {
        Source::Builtin(kind) => ai_builtin::summary(state, user, kind, &args).await,
        Source::Mcp { .. } => None,
    }
}

/// 執行一個工具，回傳給模型看的結果；失敗的原因也要給模型看（它可以換個方式再試）
pub async fn execute(state: &AppState, user: &CurrentUser, tool: &Tool, arguments: &str) -> Result<String, String> {
    let args: Value = serde_json::from_str(if arguments.trim().is_empty() { "{}" } else { arguments })
        .map_err(|_| "參數不是合法的 JSON".to_owned())?;
    if !args.is_object() {
        return Err("參數要是 JSON 物件".into());
    }
    let run = async {
        match &tool.source {
            Source::Builtin(kind) => ai_builtin::run(state, user, *kind, &args).await,
            Source::Mcp { server, tool } => state.mcp.call_tool(server, tool, args.clone()).await,
        }
    };
    let result = tokio::time::timeout(TOOL_TIMEOUT, run).await.unwrap_or_else(|_| Err("執行逾時".into()));
    result.map(|text| truncate(&text)).map_err(|text| truncate(&text))
}

fn truncate(text: &str) -> String {
    if text.chars().count() <= MAX_RESULT_CHARS {
        return text.to_owned();
    }
    let head: String = text.chars().take(MAX_RESULT_CHARS).collect();
    format!("{head}\n…（結果太長，後面省略）")
}

// ---- API ----

/// 給使用者看：自己的對話裡 AI 可以用哪些工具
#[derive(Serialize)]
pub struct ToolInfo {
    pub name: String,
    pub title: String,
    pub description: String,
    pub source: String,
    pub approval: bool,
}

#[derive(Serialize)]
pub struct MyTools {
    /// 使用中的那一組 AI 能不能呼叫工具（還沒試過當作可以）
    pub supported: bool,
    pub tools: Vec<ToolInfo>,
}

pub async fn mine(State(state): State<AppState>, user: CurrentUser) -> Result<Json<MyTools>, AppError> {
    let tools = available(&state.pool, &user).await?;
    let supported = state.ai.active_supports_tools(&state.pool).await.unwrap_or(true);
    Ok(Json(MyTools {
        supported,
        tools: tools
            .iter()
            .map(|t| ToolInfo {
                source: t.source_label(),
                name: t.name.clone(),
                title: t.title.clone(),
                description: t.description.clone(),
                approval: t.approval,
            })
            .collect(),
    }))
}

#[derive(Serialize)]
pub struct ToolView {
    pub name: String,
    pub title: String,
    pub description: String,
    /// builtin 或 mcp
    pub kind: &'static str,
    pub server_id: Option<i64>,
    pub source: String,
    pub enabled: bool,
    pub approval: bool,
    pub default_approval: bool,
}

#[derive(Serialize)]
pub struct ToolsView {
    pub servers: Vec<ServerView>,
    pub tools: Vec<ToolView>,
    /// 使用中的那一組 AI 能不能呼叫工具：null 是還沒試過
    pub provider_tools: Option<bool>,
}

pub async fn admin_view(state: &AppState) -> Result<ToolsView, AppError> {
    let (tools, servers) = all_tools(&state.pool).await?;
    let provider_tools = match crate::ai::active_provider(&state.pool).await? {
        Some(provider) => state.ai.supports_tools(provider.id),
        None => None,
    };
    Ok(ToolsView {
        servers: servers.iter().map(ServerView::from).collect(),
        tools: tools
            .iter()
            .map(|t| ToolView {
                kind: if matches!(t.source, Source::Builtin(_)) { "builtin" } else { "mcp" },
                server_id: match &t.source {
                    Source::Mcp { server, .. } => Some(server.id),
                    Source::Builtin(_) => None,
                },
                source: t.source_label(),
                name: t.name.clone(),
                title: t.title.clone(),
                description: t.description.clone(),
                enabled: t.enabled,
                approval: t.approval,
                default_approval: t.default_approval,
            })
            .collect(),
        provider_tools,
    })
}

pub async fn admin_get(_: Require<AdminUsers>, State(state): State<AppState>) -> Result<Json<ToolsView>, AppError> {
    Ok(Json(admin_view(&state).await?))
}

#[derive(Deserialize)]
pub struct ToolSettingInput {
    pub enabled: bool,
    pub approval: bool,
}

/// 開關一個工具、改要不要確認；改回預設就刪掉那一筆
pub async fn admin_set_tool(
    _: Require<AdminUsers>,
    State(state): State<AppState>,
    Path(name): Path<String>,
    Json(input): Json<ToolSettingInput>,
) -> Result<Json<ToolsView>, AppError> {
    let (tools, _) = all_tools(&state.pool).await?;
    let tool = tools.iter().find(|t| t.name == name).ok_or(AppError::NotFound)?;
    if input.enabled && input.approval == tool.default_approval {
        sqlx::query("DELETE FROM ai_tool_settings WHERE tool = ?").bind(&name).execute(&state.pool).await?;
    } else {
        sqlx::query(
            "INSERT INTO ai_tool_settings (tool, enabled, approval) VALUES (?, ?, ?)
             ON CONFLICT (tool) DO UPDATE SET enabled = excluded.enabled, approval = excluded.approval",
        )
        .bind(&name)
        .bind(input.enabled)
        .bind(input.approval)
        .execute(&state.pool)
        .await?;
    }
    Ok(Json(admin_view(&state).await?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mcp_names_are_cleaned() {
        assert_eq!(mcp_function_name("notion", "search"), "notion__search");
        assert_eq!(mcp_function_name("gh", "repo.list issues"), "gh__repo_list_issues");
        assert_eq!(mcp_function_name("x", &"a".repeat(100)).len(), 64);
    }
}
