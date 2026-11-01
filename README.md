# ouyang_web

Rust（Axum + SQLite）後端 + React（Vite）前端，打包成單一 Docker image 部署。

```
frontend/   React + Vite + TypeScript
backend/    Axum + sqlx（SQLite），同時提供 /api 與前端靜態檔
deploy/     伺服器上用的 compose.yaml、各環境設定、deploy.sh
Dockerfile  多階段建置：前端打包 → cargo-chef 編譯 → distroless 執行
```

## 本機開發

```shell
# 後端（:8080，資料庫在 backend/data/app.db）
cd backend
cargo run

# 前端（:5173，/api 會 proxy 到 :8080）
cd frontend
npm install
npm run dev
```

測試：

```shell
cd backend && cargo test
cd frontend && npm run lint && npm run build
```

資料庫 migration 放在 `backend/migrations/`，服務啟動時自動執行。

## 登入與權限

```
使用者 ──user_roles──▶ 角色 ──role_permissions──▶ 權限
alice                  admin（系統管理員）         admin.users
```

- 密碼用 argon2id 雜湊；session 是隨機 token 放在 HttpOnly cookie（`session_<env>`），資料庫只存 token 的 SHA-256，7 天過期。
- 同一個 IP 15 分鐘內登入失敗 10 次會暫停登入。
- 停用帳號、重設密碼會讓該帳號所有裝置登出；自己改密碼只保留目前這個裝置。
- 管理員不能停用自己或移除自己的 `admin` 角色，避免把自己鎖在外面。
- 自行註冊：預設關閉，管理員在 `/admin/registrations` 開關。開放時登入頁會出現「註冊」按鈕，送出的申請要管理員核准才會建立帳號（沒有任何角色）。同一個 IP 一天最多申請 3 次。

頁面：`/login` 登入、`/register` 註冊、`/account` 改密碼、`/feedback` 回報與許願、`/admin/users`、`/admin/roles`、`/admin/registrations`、`/admin/feedback`、`/admin/access`、`/admin/visits` 系統管理（需要 `admin.users`，沒有權限的人在選單裡看不到）。

### 回報與許願

頁首右上角的「💬 回報 / 許願」進 `/feedback`，每一筆是一串對話，管理員在 `/admin/feedback` 回覆、結案或刪除，雙方可以一直來回留言（`backend/src/feedback.rs`）。

- 不用登入也能送：訪客第一次送出時會拿到 HttpOnly cookie `feedback_<env>`（Path 只到 `/api/feedback`），之後靠它認出自己的對話。登入的人用帳號，也看得到同一個瀏覽器先前以訪客身分送出的。
- 圖片可以 Ctrl+V 貼上、拖曳或選檔。一貼上就先上傳（`POST /api/feedback/images`，body 是圖片本身，上限 5 MB；太大的前端會先縮小成 WebP），送出留言時才掛上去，一天內沒掛上的會被清掉。
  後端看檔頭只收 PNG / JPEG / GIF / WebP，圖片存在 SQLite（`feedback_images`），只有對話雙方和管理員看得到。
- 未讀：雙方各記看到哪一則，頁首的紅點是有新回覆的對話數；管理員的紅點還包含使用者的新留言。頁面開著時每 20 秒看一次有沒有新留言。
- 同一個 IP 一天最多開 10 串、留 100 則、傳 60 張圖（管理員不受限）。

### 建立或救回管理員

帳號已存在時會重設密碼、重新啟用並加回 `admin` 角色。密碼從 stdin 讀，不會留在指令列或 shell 歷史裡：

```shell
# 本機
cd backend && cargo run -- create-admin admin

# 伺服器（<env> 是 staging 或 prod），輸入密碼後按 Enter
cd ~/ouyang_web/<env> && docker compose exec -T app /app/backend create-admin admin
```

### 新的 APP 要加權限時

1. 新增 migration，登記權限並授權給角色：
   ```sql
   INSERT INTO permissions (name, description) VALUES ('notes.write', '編輯筆記');
   INSERT INTO role_permissions (role_id, permission) SELECT id, 'notes.write' FROM roles WHERE name = 'admin';
   ```
   需要新角色就 `INSERT INTO roles (name, description) VALUES ('editor', '編輯者');`。
2. 在 `backend/src/auth.rs` 定義權限，handler 參數加上 `Require<NotesWrite>`，沒登入回 401、沒權限回 403：
   ```rust
   pub struct NotesWrite;
   impl Permission for NotesWrite {
       const NAME: &'static str = "notes.write";
   }

   async fn create_note(Require(user, _): Require<NotesWrite>, ...) { ... }
   ```
3. 前端用 `useAuth().can('notes.write')` 決定要不要顯示，用 `<RequireAuth permission="notes.write">` 保護頁面。前端的判斷只是介面，真正的檢查在後端。

### 新增 APP

1. 在 `frontend/src/apps/registry.ts` 的 `APPS` 加一筆：`id`（網址前綴）、名稱、圖示、首頁卡片文字，以及 `nav`（側邊欄的頁面，可以分組）。需要權限才能用的 APP 設 `permission`，沒權限的人在切換面板和首頁都看不到。
2. 在 `App.tsx` 把路由包在 `<AppLayout />` 底下（要權限就再包一層 `<RequireAuth>`）：
   ```tsx
   <Route path="/notes" element={<AppLayout />}>
     <Route index element={<NotesList />} />
     <Route path=":id" element={<NoteEditor />} />
   </Route>
   ```
   桌機會有可收合的側邊欄，窄於 900px 時改成頁首的「APP › 頁面 ▾」選單。

> prod（`https://ouyang.app`）和 staging（`https://test.ouyang.app`）都走 HTTPS，`<env>.env` 設了 `COOKIE_SECURE=true`。
> cookie 沒有設 Domain，只屬於各自的網址，名稱也依環境分開（`session_<env>`），兩邊的登入互不影響。

## 小遊戲線上對戰

後端只負責轉送訊息，不懂遊戲規則；規則由兩端各自執行（`frontend/src/games/shared/useRoom.ts`、`backend/src/games.rs`）。不需要登入，但登入後會用帳號認座位。

```
POST /api/games/rooms  {"game":"gomoku"}  →  201 {"code":"ABCDE"}      game：gomoku / xiangqi / chess / reversi / connect4 / ab / battleship
GET  /api/games/rooms/{code}/ws?game=<id>&player=<id>                  升級成 WebSocket（登入時 player 可省略）

client → server  {type:"msg", data}
server → client  {type:"welcome", seat, peer, history:[{seat, data}]}
                 {type:"peer", online}
                 {type:"msg", seat, data}
                 {type:"error", code, message}   之後伺服器關閉連線
```

- 每個房間兩個座位，重連時用 player 拿回同一個座位，並收到完整歷史。**登入的人一律用帳號（`user:<id>`）**，換分頁或裝置都拿得回座位；
  訪客才用 query 的 `player`（前端每個分頁產生一個，存在 sessionStorage），伺服器存成 `guest:<player>`，所以冒用不到帳號的座位。
  之後新增的多人遊戲也要沿用這個規則。
- 同一個 player 從別處連進來時，舊連線會收到 `replaced` 錯誤後被關掉，前端不再自動重連（避免兩個分頁互踢），改顯示「在這裡繼續」。
- 任何一方送出的訊息，伺服器加上 seat 後依序存進歷史並廣播給兩邊（包含送出者），所以兩邊看到的順序完全一樣。
- 連線一律先升級，有問題再送 `error` 後關閉（瀏覽器讀不到升級失敗的 HTTP 狀態）：`not_found`、`game_mismatch`、`full`、`bad_request`、`replaced`、`internal`，
  以及送太快（每秒超過 20 則）的 `rate_limited`、太大（data 超過 4KB）的 `too_large`、歷史超過 2000 筆的 `history_full`。
- 伺服器每 25 秒送一次 ping；60 秒沒收到任何東西就當作斷線。
- 沒有人連線超過 30 分鐘、或建立超過 24 小時的房間就失效，並在下次有人建立房間時從資料庫刪掉。房間最多 1000 個，超過回 503。
- 房間、座位和歷史存在資料庫（`game_rooms`、`game_events`），記憶體只放有人連線中的房間。重啟或換版後，前端自動重連就能接著下。
- 換版的幾秒內新舊容器可能各有同一個房間的連線：座位用條件式 UPDATE 搶，事件用 `(room_code, seq)` 主鍵擋重複序號。
  寫入時序號撞到，就關掉那個容器裡這個房間的連線，前端重連後從資料庫重新載入，送出的那一步要重下。

### 海戰棋

`/games/battleship`：也用上面的轉送房間，但佈局是祕密，不能放進會廣播給雙方的訊息（`frontend/src/games/battleship/`）：

- 開局各自送出 `commit = SHA-256(佈局 + 隨機 salt)`，佈局和 salt 只存在自己的瀏覽器（localStorage，用房間、座位、局數和雜湊當 key，重連時拿回來）。
  雜湊用 `hash-wasm`，因為 `crypto.subtle` 只在 HTTPS 能用。
- 每一砲由被打的一方自己算出「沒中／擊中／擊沉」回報，擊沉時公布那艘船的位置；位置不合理（和先前的回報對不上）當場判亂報的一方輸。
- 結束後雙方自動公開佈局和 salt，前端驗證雜湊和過程中的每一次回報，對不上就判對方輸。換裝置或清掉瀏覽器資料就拿不回佈局，只能認輸。

### 1A2B 對戰

`/games/ab` 的「對戰」：雙方各藏一組數字輪流猜，可以對電腦（三種難度）或線上。線上一樣走上面的轉送房間，
但轉送伺服器會把訊息給雙方看，所以祕密數字絕對不送出去（`frontend/src/games/ab/versusRules.ts`）：

- 開局各自送 `commit = SHA-256("數字:salt")`（salt 是 16 bytes 亂數，不能靠 5040 種窮舉回推；用 `hash-wasm`，http 的 staging 也能算）。
- 對方猜了，由被猜的那一方的瀏覽器用自己的數字算 A／B 自動回報；數字和 salt 存在 localStorage（連 commit 一起存），重連後重播歷史也回報得了。
- 分出勝負後雙方公開數字和 salt，用戶端驗證雜湊和每一次回報，對不上就判那一方輸。換了裝置找不到自己的數字時只能認輸。

### 俄羅斯方塊 99

`/games/tetris`：參考 Tetris 99 的大逃殺，一間最多 99 人，人不夠由電腦補位。和上面的棋類不同，伺服器懂一部分規則
（`backend/src/arena.rs`，和魔法氣泡共用；俄羅斯方塊的盤面格式和電腦玩家在 `tetris.rs`。協定寫在 `frontend/src/games/shared/useArena.ts`）：

```
POST /api/games/tetris/rooms  {"public":true}  →  201 {"code":"ABCDE"}   public：快速配對，加入正在等人的公開房間，沒有就開一間
GET  /api/games/tetris/rooms/{code}/ws?player=<id>&name=<暱稱>           升級成 WebSocket（登入時用帳號與帳號名稱）
```

- 每個人的盤面在自己的瀏覽器裡跑（`engine.ts`：SRS、7-bag、T／L／J／S／Z／I 的 spin、連擊、B2B），伺服器只收攻擊行數、盤面快照和出局，
  負責選目標（隨機／快輸的／徽章／反擊，或手動點小盤面）、轉送垃圾行、算 KO、徽章、名次與速度等級，以及模擬電腦玩家。
- 房間每 250ms 推進一次，這段時間的狀態和盤面變化合併成一則廣播。
- 電腦玩家沒有真的在下方塊，是用機率模擬放塊、消行和被攻擊推高。大部分是弱的，前期就會陸續出局；每 7 個有 1 個強的（至少一個）撐到後面。
  等級越高越容易失誤，只剩電腦時大約四、五分鐘分出勝負。調整時用 `cargo test --release pacing -- --ignored --nocapture` 看每個時間點出局了幾個。
- 房間只放在記憶體：**重啟或換版時進行中的對局會中斷**。沒人連線 2 分鐘就收掉，最多 200 間。
- 對局中斷線 10 秒判出局；重新整理後手上沒有這局的盤面，會直接認輸、等下一局。
- 單人模式每消 10 行或每玩 1 分鐘升一級（看哪個先到），沒有上限；分數照官方規則（消行、spin、B2B、連擊、全消乘上等級，加上下落格數）。
  登入的人的成績會上傳到排行榜（`backend/src/tetris_scores.rs`，每個帳號只留最高分）：

  ```
  GET  /api/games/tetris/scores                 →  {"top":[{rank,username,score,lines,level,duration_ms,achieved_at}],"me":{…}|null}
  POST /api/games/tetris/runs                   →  201 {"id"}   開局，伺服器記下開始時間（要登入，一個帳號同時一局）
  POST /api/games/tetris/runs/{id}/checkpoints  {"score","lines","level","pieces","duration_ms","board"}  →  204
  POST /api/games/tetris/runs/{id}/finish       同上  →  排行榜再加 "best"（有沒有刷新紀錄）
  ```

  分數是前端算的，伺服器不重播整局，而是每 5 秒（遊戲時間）檢查一次中間態來確認真的有玩：遊戲時間不能超過實際經過的時間、
  數字只增不減且增加速度合理、盤面沒有滿行且格數等於「方塊數 × 4 − 行數 × 10」。有一次不合理整局作廢。
  進行中的局只放在記憶體，重啟或換版時正在玩的那局無法上傳。
- 背景音樂是 Korobeiniki（俄羅斯民謠），用 Web Audio 即時合成（合成器在 `games/shared/music.ts`，曲子在 `tetris/music.ts`），不需要音檔：三角波旋律、正弦波低音，
  加上低通濾波和一點回音讓聲音柔和；速度跟著等級變快，按 M 或按鈕開關。
- 快捷鍵可以自訂（`games/shared/keys.ts`、`games/shared/KeyEditor.tsx`，和魔法氣泡共用），每個動作最多兩個鍵。沒登入存在瀏覽器，有登入存在帳號（`backend/src/game_settings.rs`），
  換裝置也一樣；帳號還沒存過時沿用瀏覽器的設定：

  ```
  GET /api/games/tetris/settings  →  {"keys":{"left":["ArrowLeft"],…}|null}   null 是沒存過（要登入）
  PUT /api/games/tetris/settings  {"keys":{…}|null}  →  204                   null 是恢復預設
  ```

### 魔法氣泡

`/games/puyo`：參考ぷよぷよ通的規則，有單人模式、一對一對戰電腦（全部在瀏覽器裡跑，`frontend/src/games/puyo/`），
以及和俄羅斯方塊一樣的大逃殺。和俄羅斯方塊共用快捷鍵、背景音樂合成器、排行榜和大逃殺的元件（`games/shared/`）。

- 規則（`engine.ts`）：6 × 12 的盤面加上看不到的第 13 列，兩顆一組、四種顏色，同色 4 顆以上相連就消掉，可以連鎖。
  分數照官方公式：10 × 消掉的顆數 × (連鎖倍率 + 連結加成 + 顏色加成)。第 3 欄最上面被堵住就輸。
  消除和掉落是有時間的動畫，連鎖一步一步推進，看得到每一連。
- 對戰：兩邊用同一個亂數種子，拿到一樣順序的氣泡。每 70 分換一顆干擾泡，先抵銷自己待落下的再送出去；
  開打 96 秒後進入加時，換算分數每 16 秒變成 3/4。全消後下一次連鎖多送 30 顆。
- 電腦（`cpu.ts`）：每組把所有落點（最多 22 種）都模擬一次，看現在能不能打出夠大的連鎖、「再補一兩顆能引爆幾連鎖」和盤面形狀；
  困難再把下一組也考慮進去（只從最好的 8 個落點往下看，手機上不會卡）。三種難度差在想多久、動多快、要等幾連鎖才引爆。
- 單人模式每放 30 組或每玩 1 分鐘升一級。登入的人的成績會上傳到排行榜（`backend/src/puyo_scores.rs`），做法和俄羅斯方塊一樣檢查中間態：

  ```
  GET  /api/games/puyo/scores                 →  {"top":[{rank,username,score,max_chain,level,duration_ms,achieved_at}],"me":{…}|null}
  POST /api/games/puyo/runs                   →  201 {"id"}
  POST /api/games/puyo/runs/{id}/checkpoints  {"score","level","pieces","popped","lost","max_chain","duration_ms","board"}  →  204
  POST /api/games/puyo/runs/{id}/finish       同上  →  排行榜再加 "best"
  ```

  伺服器檢查：盤面沒有懸空的氣泡、沒有該消沒消的四連、顆數等於「組數 × 2 − 消掉的 − 疊出界的」；
  分數增加不超過「消掉的顆數 × 9990」（倍率上限 999）加上下落與全消的分數。前端只在有一組在操作時回報（連鎖途中的盤面還沒算完）。
- 大逃殺（`backend/src/puyo.rs`）：房間、選目標、KO 和徽章和俄羅斯方塊共用 `arena.rs`，只能用房間代碼或邀請連結加入（沒有快速配對）。
  攻擊單位是干擾泡顆數，盤面是 13 × 6 個 `0`～`5`（含看不到的第 13 列，`5` 是干擾泡）；速度等級最多用到 10：

  ```
  POST /api/games/puyo/rooms  →  201 {"code":"ABCDE"}
  GET  /api/games/puyo/rooms/{code}/ws?player=<id>&name=<暱稱>
  ```

  電腦玩家每一手放兩顆，其中一部分「有用」，存夠了就引爆一串連鎖（強的打得比較長），干擾泡照前端的公式換算（含加時）；
  弱的放得亂，沒用的氣泡越積越高。
- 背景音樂是另外寫的一段輕快小曲（`puyo/music.ts`），不是原作配樂。快捷鍵存在 `/api/games/puyo/settings`（格式同俄羅斯方塊）。

### 派對房間

給「有隱藏資訊、3～10 人、回合制或計時」的遊戲用（誰是臥底、踩地雷競速，之後的大老二、你畫我猜…）。和上面兩種房間都不同：
規則全部在伺服器（`backend/src/party.rs`），用戶端只送「我想做什麼」，伺服器驗證後改狀態，再把**每個座位各自的視角**送出去，
別人的牌、別人的詞根本不會離開伺服器。協定寫在 `frontend/src/games/shared/useParty.ts`，大廳、聊天等元件在 `games/shared/Party.tsx`。

```
POST /api/games/<遊戲>/party              →  201 {"code":"ABCDE"}
GET  /api/games/<遊戲>/party/{code}/ws?player=<id>&name=<暱稱>
```

- 房間只放記憶體：伺服器重啟或換版時進行中的房間會消失（用戶端會收到「房間已經關閉」）。沒人連線 5 分鐘後清掉，最多 200 間。
- 第一個進來的人是房主，離開就輪到下一個人。房主可以改選項、加減電腦玩家、請人離開（之後不能再進來）、開始和中止。
  開局時連著線的人加上電腦照名單順序入座，超過人數上限的人和對局中才進來的人觀戰，下一局再加入。一局結束後可以「再來一局」，分數由遊戲自己累計。
- 認人的方式和大逃殺一樣：登入認帳號，訪客認分頁。對局中斷線的人保留座位，怎麼處理（逾時跳過、自動出手）由遊戲決定。
- 送出去的有三種：每個人自己的 `view`（狀態有變才重送，內容一樣就不送）、遊戲的即時事件 `event`（不存，例如筆畫）、聊天。
  對局中的聊天會先交給遊戲決定誰看得到，例如出局的人只能跟出局、觀戰的人聊。
- 每條連線每秒最多 20 則、一則最多 4 KB（遊戲可以調整），超過就斷線。
- 新增一款遊戲：實作 `PartyGame`（見 `party.rs` 檔頭的步驟）、在 `AppState` 加一份房間表、掛兩條路由，前端用 `useParty` 和共用元件。

### 誰是臥底

`/games/undercover`：第一款派對遊戲（`backend/src/undercover.rs`）。大部分人拿到同一個詞（平民），一兩個人拿到相近的另一個詞（臥底），
可以多一個沒有詞的白板（算臥底這邊）。每個人只看得到自己的詞，不知道自己是哪一邊。

- 流程：看詞 → 依序每人一句描述（不能包含自己的詞，伺服器檢查；有發言時間）→ 討論（可以設 0 秒跳過）→ 投票。
  票最多的人出局；平手只在平手的人之間重投一次，再平手這輪沒人出局，投完公開誰投誰。白板出局時可以猜一次平民的詞，猜中臥底這邊直接贏。
- 勝負：臥底和白板全部出局平民勝；臥底這邊的人數追上平民就臥底勝。分數在同一個房間累計（平民贏每人 1 分、臥底這邊贏每人 2 分）。
- 選項：臥底人數（自動是 5 人以下 1 個、6～8 人 2 個、更多 3 個，白板佔一個名額）、白板、線下模式（當面口頭描述，網站只負責發詞、輪流和投票）、
  出局時要不要公開身分、發言和討論的秒數。臥底這邊一定要比平民少，配不出來時不能開始。
- 出局和觀戰的人只能在旁邊聊天，場上的人看不到；聊天裡直接說出自己的詞不會送出。
- 詞庫在 `backend/src/undercover_words.txt`（160 多組，每個詞附幾句描述）。電腦玩家發言時從自己那個詞的描述裡挑一句，白板電腦用通用的模糊描述；
  投票看誰的描述和自己的詞最不像，再加上跟票。電腦只知道自己的詞，跟真人一樣。

### 大老二

`/games/bigtwo`：4 人的派對遊戲（`backend/src/bigtwo.rs`），人不夠由房主加電腦補到 4 人。每個人的 view 只有自己的手牌，其他人只看得到張數，結束時才公開剩下的牌。

- 台灣常見的玩法：3 最小、2 最大，同點數比花色 ♠ > ♥ > ♦ > ♣。牌型有單張、對子，以及五張牌型：順子 < 同花 < 葫蘆 < 鐵支 < 同花順，同張數才能壓。
  第一局拿到 ♣3 的人先出（第一手要包含 ♣3），之後由上一局的贏家先出。pass 之後這一圈還能再出，其他三家都 pass 就由最後出牌的人重新出。
- 計分：有人出完時，其他人照剩下的張數扣分，10 張以上加倍、13 張三倍，贏的人拿走全部扣分；分數在同一個房間累計。
- 房主的選項（括號是預設）：同花算不算牌型（算）、鐵支和同花順能不能壓單張和對子（不能）、三條（不能出）、
  順子大小（2 最大：34567 最小…10JQKA < A2345 < 23456；或 A 當 1：A2345 最小）、結算時手上每張 2 再加倍（不加倍）、每手思考時間（30 秒，可以不限）。
  JQKA2 這種繞過 2 的不算順子。
- 時間到或斷線（等 5 秒）會自動處理：能 pass 就 pass，自由出牌就出最小的單張。
- 輪到自己時 view 會附上所有能出的組合，「提示」就在裡面輪流切換，選的牌是不是能出也靠這份清單判斷，前端不用重寫一次規則。
- 電腦玩家先把手牌拆成「出最少次就能出完」的組合（對自己手牌的每個子集合做動態規劃），再用代價挑要出哪一手：保留對子和五張牌型、
  2 和 A 留到要搶出牌權或擋人時才用、有人只剩一兩張時優先擋。每手想 0.8～1.5 秒。

### 踩地雷競速

`/games/minesweeper` 的「線上競速」模式（`backend/src/minesrace.rs`，派對遊戲 id 是 `minesrace`），1～8 人，可以加電腦。
所有人同一個盤面，比誰先把安全格全部打開。原本的單人模式不變（雷在瀏覽器裡埋），兩種模式共用 `minesweeper/Board.tsx` 的格子元件。

- 地雷只在伺服器上：用戶端只送「翻開／插旗／雙擊數字」，伺服器只把自己的盤面送回來（即時事件，不重送所有人的 view），整個盤面結束後才公開。
- 公平開局：埋好雷後找最大的一塊「0」，替每個人先打開同一塊，倒數 3 秒（看得到起點但不能動）後開始。
- 踩到地雷：預設凍結 5 秒（那顆雷標出來），房主可以改成直接出局。難度和單人一樣有初級、中級、高級，時間上限 5／10／20 分鐘。
- 名次照完成的時間，沒完成的照打開的格數排；第 1 名得「人數」分，每差一名少 1 分，沒完成的再少 1 分，同一個房間累計。
  真人都結束（完成、出局或斷線）後，剩下的電腦最多再等 30 秒。
- 別人的進度：大家同一個盤面，送出別人「哪幾格打開了」等於告訴你哪些格子安全，所以對局中只送每 3×3 一塊開了多少的熱度圖，
  自己結束了（或整局結束）才看得到完整的縮圖。進度最多每 0.5 秒更新一次，有人完成或出局時立刻更新。
- 電腦玩家真的在解這個盤面：只看自己翻開的數字，用單格和兩格子集推理找安全格和雷，推不出來就挑機率最低的格子猜，偶爾手滑亂點。
  速度和手滑的機率看房主選的強度（簡單／普通／困難），每個電腦再各自快一點或慢一點。

### 你畫我猜

`/games/draw`：派對遊戲（`backend/src/draw.rs`），2～10 人，不能加電腦。每一圈每個人輪流畫一次（房主選 1～3 圈、每棒 60～120 秒）。

- 輪到的人從簡單、普通、困難各一個詞裡挑一個（15 秒沒挑就隨機），其他人在聊天室猜。時間過一半和剩四分之一時各揭露一個字（兩個字的詞只揭露一個），
  可以選擇要不要提示詞的分類。所有連著線的人都猜中或時間到就公布答案，幾秒後換下一個人；畫的人斷線 8 秒就跳過他。
- 答案只在畫的人和已經猜中的人的 view 裡。猜題走聊天：猜中的那句只有自己看得到，其他人看到「某某猜對了」；只差一個字或打中大半會私下提示「差一點」；
  整句裡有答案但多打了其他字的不送出（不然答案就公開了）。猜中的人和畫的人之間的對話，還沒猜中的人看不到；畫的人和觀戰的人說出答案也不會送出。
- 計分：猜中得 20～100 分（越早越高），畫的人每有一個人猜中得 25 分，普通的詞乘 1.2、困難的乘 1.5，分數在同一個房間累計。
- 筆畫：畫布座標固定是 1000×750 的整數，顏色和粗細是調色盤的編號。畫的人按下時送 `begin`，之後每 50ms 把累積的點用 `more` 接在最後一筆後面，
  另外有 `undo`、`clear`。伺服器驗證後存進這一棒的畫布，用即時事件轉給其他人（不重送 view）；每個動作讓畫布的版本加一，
  用戶端靠版本把 view 裡的整張畫布和之後的事件接起來（`frontend/src/games/draw/board.ts`），重連、中途觀戰的人從 view 拿回整張畫布。
  一棒最多 600 筆、2 萬個點，一則訊息最多 200 個點；這款遊戲的限速放寬到每秒 50 則、一則 8 KB。
- 詞庫在 `backend/src/draw_words.txt`（680 多個詞，分難度和分類）。

## 日曆

`/calendar`：月曆（農曆、節氣、節日、放假日標紅）、`/calendar/holidays` 整年的節日與節氣、`/calendar/events` 我的事項。

- 農曆用查表法（`frontend/src/calendar/lunar.ts`，1900–2100 年）。瀏覽器內建的 `Intl` 中國曆在朔日靠近午夜時會差一天（例如 2027 年春節），所以不用它。
- 節氣用 Meeus 的太陽視黃經簡化公式推算（`solarTerms.ts`），以台灣時間為準。
- 放假日依「紀念日及節日實施條例」推算，含補假與 2025 年修法新增的假日（`holidays.ts`）。人事行政總處每年公告的調整放假和補班不能推算，要逐年加到 `ADJUSTMENTS`。
- 個人事項只要登入就能用，每個人只看得到自己的。後端（`backend/src/calendar.rs`）只存事項和重複規則，每一次落在哪天由前端展開（`events.ts`），因為農曆重複要換算農曆。

```
GET    /api/calendar/events          自己的所有事項
POST   /api/calendar/events          新增
PUT    /api/calendar/events/{id}     整筆取代（別人的事項回 404）
DELETE /api/calendar/events/{id}

{ title, note, color, start_date, end_date,       日期 YYYY-MM-DD，end_date 含當天
  repeat, interval, weekdays, until, excluded }  repeat：none / daily / weekly / monthly / yearly / lunar_monthly / lunar_yearly
```

「只刪這一次」是把那次的開始日期加進 `excluded`。修改重複事項會套用到每一次。

## 小工具

都在瀏覽器裡執行，後端不參與。工具登記在 `frontend/src/tools/registry.ts`，每個工具各自打包、進到那一頁才下載。

- **圖片去背**：模型在 Web Worker 裡用 transformers.js 跑，從 Hugging Face 下載後存在瀏覽器快取。
  自動去背用 `Ko033/isnet-general-use-onnx`（WebGPU 用 fp16 約 88 MB，CPU 用 int8 約 46 MB），點選用 `Xenova/slimsam-77-uniform`（第一次點選才下載），兩者都是 Apache-2.0。
  onnxruntime 的 wasm（27 MB，gzip 後約 7 MB）跟著網站部署，不走 CDN；只有舊版 Safari 沒有 WebGPU 時才從 jsdelivr 載入另一個版本。
  Docker 打包時會把大於 1 KB 的 JS／CSS／wasm 等另存一份 `.gz`，後端看到瀏覽器支援 gzip 就直接送壓縮版。
- **匯率計算機**：瀏覽器直接呼叫 Frankfurter v2（`api.frankfurter.dev/v2`，彙整各國央行匯率，含 TWD），最新匯率存在 localStorage，離線時顯示上次的資料。
- **ASCII 藝術字**：figlet 的 `.flf` 字型當成靜態檔輸出，選到才 fetch。
- **Emoji 選擇器**：資料來自 `emojibase-data`（繁中＋英文）。**編碼與雜湊**：雜湊用 `hash-wasm`。

## IP 訪問紀錄

「系統管理 › IP 訪問紀錄」（`/admin/access`，需要 `admin.users`）：全站每個請求的來源 IP、方法、路徑、狀態碼、花費時間、登入的帳號和 User-Agent，
可以依 IP 彙整（依最後活動或請求數排序，展開看那個 IP 的請求），或看最近 500 筆請求。程式在 `backend/src/access_log.rs`。

```
GET /api/admin/access?hours=24&sort=recent|requests   統計、前 300 個 IP、請求最多的 15 個路徑      hours：1～720
GET /api/admin/access/requests?hours=24&ip=&errors=   最近 500 筆請求（可以只看某個 IP、只看 4xx／5xx）
```

- 用 middleware 記錄，IP 跟登入限制一樣取 Traefik 的 X-Forwarded-For。前端打包出來的靜態檔（`STATIC_DIR` 最上層有的檔案和資料夾）、
  `/api/health` 和這個頁面自己的查詢不記；不存在的路徑（掃描器找的 `/wp-login.php`、`/.env`）會記。
  前端沒有點開頭的路徑，所以 `/.env`、`/.git/config` 這類直接回 404，不會拿到 index.html（`lib.rs` 的 `hide_dot_paths`）。
- 請求本身不碰資料庫：先放在記憶體，背景每 2 秒整批寫進 `access_logs`，帳號也是那時才從 session 查（登入那一次還沒有 cookie、
  登出那一次 session 已刪，都算訪客）。關機時會寫完剩下的，被強制結束的話最後幾秒會遺失。
- 保留 30 天，每小時清一次。同一個 IP 10 分鐘超過 1000 筆的部分不記，避免被灌爆。

## 隱藏頁面

不在任何選單、首頁或工具清單裡，只有知道網址的人進得來；頁面加了 `noindex`。誰來過記在「系統管理 › 頁面訪客」（`/admin/visits`，需要 `admin.users`）。

- **`/bcs` Data Matrix 生成器**：倉位（SLOC / BIN / STYP）和料件（MODEL / MO / QTY / DC / SER）兩種內容產生 Data Matrix，最愛和歷史存在 localStorage。
  掃描在支援 BarcodeDetector 的瀏覽器即時掃相機，其他（iOS）改成拍照後解碼，解不出來再用 ZXing。相機和 BarcodeDetector 都只在 HTTPS 能用，HTTP 下一律走拍照。

```
POST /api/visits/{page}                  {session, action, detail}   action：open / click / scan / error，不用登入
GET  /api/admin/visits/{page}            統計和最近 300 次瀏覽（每個分頁一次）
GET  /api/admin/visits/{page}/{session}  那次瀏覽的事件
```

- 前端用 `useVisitTracking`（`frontend/src/visits.ts`）：進頁面送 open，頁面裡的按鈕被點送 click（名稱取 `data-track` 或按鈕文字），JS 錯誤送 error（每次瀏覽最多 20 筆）。
- 後端補上來源 IP（Traefik 的 X-Forwarded-For）、登入的帳號和 User-Agent，存在 `page_events`，保留 180 天。同一個 IP 10 分鐘超過 200 筆就不再記。
- 新增隱藏頁面：在 `backend/src/visits.rs` 的 `PAGES` 加上 id，頁面裡呼叫 `useVisitTracking('<id>', rootRef)`。

## 音樂

`/music`：播放伺服器上一個資料夾裡的音樂，`/music/favorites` 是收藏。檔案由 Discord bot（Xiao-Xia）放進
`~/Xiao-Xia/data/attachments/572417837537296396`，`compose.yaml` 把它唯讀掛到容器的 `/music`（路徑寫在 `<env>.env` 的 `MUSIC_HOST_DIR`，staging 和 prod 共用同一個資料夾）。

```
GET /api/music                 [{ name, size, modified }]   modified 是 Unix 毫秒；每次都重新讀資料夾，bot 新增的檔案馬上看得到
GET /api/music/files/{name}    檔案本身，支援 Range（拖曳進度）
GET /api/music/s/{hex}.{ext}   同上，分享用：檔名（不含副檔名）的 UTF-8 十六進位，回應帶原本檔名的 Content-Disposition
```

- 只認最上層、不是隱藏檔、副檔名是 mp3 / m4a / aac / ogg / oga / opus / wav / flac / webm 的檔案，其他一律 404。
- 本機開發用 `MUSIC_DIR` 指定資料夾，沒設就讀 `backend/data/music`，不存在就是空清單。
- 收藏、音量、隨機和循環設定存在瀏覽器的 localStorage，不跟帳號走。播放器放在 APP 的外層，切換「全部」「收藏」不會中斷，離開音樂 APP 才會停。
- 每首歌的分享鈕給的是音檔本身的網址：Telegram、Discord 只有直接連到音檔才會在聊天室裡顯示播放條，
  連到網頁的話不會。手機用系統的分享選單，電腦直接複製。
  Telegram 只幫網域產生預覽（貼 IP 的不會），路徑裡有中文的也不會（編不編碼都一樣），
  所以檔名不是單純英數字時改用 `/api/music/s/` 的十六進位網址，例如 `三蛋一體.mp3` → `/api/music/s/E4B889E89B8BE4B880E9AB94.mp3`。

## 天氣與環境

`/weather`：總覽、`/weather/typhoon` 颱風、`/weather/forecast` 全台天氣、`/weather/quake` 地震。後端在 `backend/src/weather/`，外部資料都由後端抓、整理過再給前端。

```
GET /api/weather/typhoons      颱風（各來源合併）  快取 10 分鐘
GET /api/weather/forecast      22 縣市天氣與空氣品質  快取 15 分鐘
GET /api/weather/quakes        最新速報、各國地震報告、速報連線狀態  報告快取 3 分鐘
GET /api/weather/quakes/ws     即時速報  server → client  {type:"snapshot", eew:[...]}、{type:"eew", eew}
```

- 有人來看才抓，同一時間只有一個請求真的打外部 API；外部來源掛掉時繼續回上一次成功的資料，頁尾標出哪個來源暫時連不上。
- **颱風・官方路徑**：日本氣象廳（過去路徑、強度、70% 機率圓、暴風圈）、GDACS 整理的 JTWC／NHC（全球，含不確定範圍）、中央氣象署（要金鑰）。
  各來源的颱風依目前位置合併（600 公里內視為同一個）。GDACS 在颱風消散後還會掛一陣子，美國那邊用 NHC 自己的清單過濾。
- **颱風・AI 系集**：Google DeepMind Weather Lab 的系集預報（`OPER` 模型，每 6 小時起報，發布比起報晚 6～8 小時），平均路徑加上 50 個成員。即時資料受其使用條款約束，頁面上有標示。
  官方和 AI 畫在同一張圖，用圖層開關分別顯示或隱藏（AI 的開關記在 localStorage）。
- **首頁颱風區**：西北太平洋有官方資料的颱風才出現，地圖（Leaflet）在那時才下載。
- **天氣**：Open-Meteo（免金鑰，一次請求查 22 縣市），空氣品質是美國 AQI。
- **地圖底圖**：Esri 的淺灰／深灰 Canvas，跟著主題切換（CARTO 已經要金鑰）。線條顏色用 CSS class 控制，才吃得到主題變數。
- **地震速報**：伺服器一啟動就連 wolfx 的 `cwa_eew`、`jma_eew`、`sc_eew`、`fj_eew`，經過主機上的 relay（`EEW_RELAY_URL`，和歐陽小俠共用同一條上游）。
  wolfx 同一個 IP 大約只給 5 條 WebSocket，所以只連小俠也在用的這 4 個，地震清單改用 HTTP；relay 連不上時也**不會**改成直連，避免和 relay 搶連線。
  沒設 `EEW_RELAY_URL`（本機開發）就直接連 wolfx。台灣速報的 HTTP 版被 Cloudflare 擋，啟動後要等推送才有資料。
- **地震報告**：USGS（台灣附近 M3+、全球 M4.5+）、wolfx 轉的日本氣象廳與中國地震台網清單、中央氣象署（要金鑰）。
- 地震頁的 S 波倒數與當地震度是用 3.5 km/s 和台灣常用的 PGA 衰減式粗估，「測試速報畫面」按鈕只在自己的瀏覽器裡模擬一筆。

### 中央氣象署的金鑰

在伺服器上建立 `~/ouyang_web/<env>/secrets.env`（不進 git，部署也不會覆蓋），下次部署就會帶進容器：

```shell
echo 'CWA_API_KEY=CWA-XXXXXXXX' > ~/ouyang_web/prod/secrets.env
chmod 600 ~/ouyang_web/prod/secrets.env
```

有金鑰才會抓的資料：颱風路徑 `W-C0034-005`（含中文名稱）、顯著與小區域有感地震報告 `E-A0015-001`／`E-A0016-001`。
本機開發直接 `CWA_API_KEY=... cargo run`。

## LoL 世界賽

`/lol` 賽況（正在打的比賽：直播＋即時數據，沒有比賽時是下一場倒數）、`/lol/schedule` 賽程、`/lol/standings` 戰績（瑞士輪、淘汰賽對戰表、入圍賽）、`/lol/match/{id}` 單場的每一局。

後端不參與，瀏覽器直接呼叫 lolesports.com 自己用的 API（都開放 CORS），程式在 `frontend/src/lol/api.ts`：

```
esports-api.lolesports.com/persisted/gw   要帶 x-api-key（lolesports.com 前端內建的公開金鑰）
  getTournamentsForLeague   取最新一屆
  getSchedule               整屆賽程（分頁，往前往後翻到超出這屆的日期）
  getStandings              各階段有哪些比賽（只用來分類，排名由前端從比賽結果算）
  getLive                   正在打的比賽與直播來源，30 秒更新
  getEventDetails           單場的每一局、VOD、直播來源
feed.lolesports.com/livestats/v1/window/{gameId}?startingTime=   即時數據，時間要對齊 10 秒
ddragon.leagueoflegends.com                                      英雄頭像與中文名稱
```

- 賽程、直播狀態在 APP 外層（`LolApp`）抓，一分鐘更新一次（API 本身有一分鐘的 CDN 快取）；分頁切到背景時暫停。
- 即時數據查太接近現在的時間會回 400，所以查一分鐘前的，畫面上會註明延遲。
  已結束的局要找終局數據：從開場往後二分搜尋還查得到的最後一段（約 10 次請求），結果存在 localStorage（最多 40 局）。
- 直播和 VOD 預設繁中，其次英文。YouTube 直接嵌入；Twitch 只讓 HTTPS 網站嵌入，網站還是 HTTP 時改顯示連結。
- 這些都是非公開 API，Riot 改版時可能要跟著調整。

## 部署

| 環境 | 觸發 | Image tag | 網址 |
|---|---|---|---|
| staging | merge / push 到 `dev` | `staging-<commit>`、`staging-latest` | `https://test.ouyang.app` |
| prod | merge 到 `main` | `prod-<commit>`、`prod-latest` | `https://ouyang.app` |

分支流程：

```
feature/xxx ──PR──▶ dev ──PR──▶ main
                     │            │
                  staging        prod
```

- `main` 受保護：只能透過 PR 合併，且 CI 的 `test` 必須通過，不能 force push 或刪除。
- 對 `dev` / `main` 開的 PR 只會跑測試，merge 後才會建置並部署。

### 不斷線部署（Traefik + docker-rollout）

```
外部 ─▶ Traefik :443 ─┬─ Host ouyang.app      ─▶ prod 的 app 容器
                      └─ Host test.ouyang.app ─▶ staging 的 app 容器（app 容器都不直接對外綁 port）
```

網域 `ouyang.app` 在 Cloudflare 註冊，DNS 有 `@` 和 `test` 兩筆 A 紀錄指到伺服器，都設成 **DNS only**（灰色雲朵，不經過 Cloudflare 代理）。
網址寫在 `<env>.env` 的 `APP_HOST`，app 的 router 規則是 `Host(APP_HOST)`；Traefik 的 entrypoint 名稱 `prod` 是沿用舊的，兩個環境都走這裡。
新增網域時，`traefik/compose.yaml` 的 `tls.domains` 也要加上。
HTTPS 憑證由 Traefik 向 Let's Encrypt 申請（TLS-ALPN-01，只走 :443），每個網域一張，到期前自動續約，存在 volume `ouyang-web-traefik_letsencrypt`。
不開 :80：`.app` 在瀏覽器的 HSTS 預載清單裡，瀏覽器本來就只會用 https 連。AWS 安全群組只要開 443。

之後若要開 Cloudflare 代理（橘色雲朵），先處理這幾件事：
- SSL/TLS 模式設 Full (strict)。Cloudflare 會在它那邊結束 TLS，TLS-ALPN-01 驗證不到伺服器，要改成 DNS-01（Cloudflare API token，只給這個 zone 的 DNS 編輯權限）。
- 來源 IP：`auth.rs` 的 `client_key` 取 X-Forwarded-For 最後一筆，也就是直接連進 Traefik 的那台，開代理後會變成 Cloudflare 的節點；
  只讓 Traefik 信任 Cloudflare 的 IP 範圍也不夠（Traefik 會把直接連線的 IP 接在最後）。要改成最後一筆是 Cloudflare 的 IP 時才讀 `CF-Connecting-IP`。

`deploy.sh` 用 `docker rollout` 換版：先啟動新容器 → 等 healthcheck 通過 → 再等 3 秒讓 Traefik 接上 → 停掉舊容器。

舊容器收到 SIGTERM 後不會馬上關：先讓 `/api/health` 回 503（draining），其他請求照常處理 5 秒（`DRAIN_SECS`），
Traefik 每秒主動檢查 health，看到 503 就把它移出負載平衡，之後才真正停止。換版瞬間的連線錯誤另由 retry middleware 重送。

**migration 必須跟上一版相容**：換版期間新舊兩版會同時跑在同一個 SQLite 上。
例如要改欄位名稱，分兩次部署：先加新欄位並讓程式兩邊都寫，下一版再移除舊欄位。

`/api/health` 會回傳 `commit`，可以用來確認目前是哪一版在接流量。

每次部署成功後會清掉同環境的舊 image：伺服器上只留這次的加上前 2 版（`deploy.sh` 的 `KEEP_PREVIOUS_IMAGES`），
GHCR 上留最近 10 版（workflow 的 `cleanup` job）。

回滾：在伺服器上改 `.env` 的 `IMAGE` 再 rollout（本機現有的版本用 `docker image ls` 看，更舊的 tag 在 GitHub 的 Packages 頁面，要先 `docker login ghcr.io` 才拉得到）：

```shell
cd ~/ouyang_web/prod
sed -i 's#^IMAGE=.*#IMAGE=ghcr.io/ouyangminoa/ouyang_web:prod-<commit>#' .env
docker rollout app
```

### 需要的 GitHub secrets

- `SERVER_HOST`：伺服器 IP
- `SERVER_USER`：`ubuntu`
- `SSH_PRIVATE_KEY`：部署專用的 SSH 私鑰（公鑰在伺服器的 `~/.ssh/authorized_keys`）

拉 image 用的是 workflow 的 `GITHUB_TOKEN`，伺服器上不存放長期的 registry 憑證。

### 伺服器上的檔案

```
~/ouyang_web/staging/   compose.yaml、staging.env、deploy.sh、traefik/（每次部署覆蓋）、.env（deploy.sh 產生）
~/ouyang_web/prod/      同上
~/ouyang_web/<env>/secrets.env   手動放的金鑰（CWA_API_KEY），deploy.sh 會併進 .env
```

Traefik 以固定的專案名稱 `ouyang-web-traefik` 執行，staging 和 prod 共用，所以修改 `deploy/traefik/` 會同時影響兩個環境。

資料庫在 Docker volume `ouyang-web-staging_data` / `ouyang-web-prod_data`。
