//! 西北太平洋及南海颱風的國際命名與中文譯名（中央氣象署〈颱風中文譯名及國際命名對照表〉，2026 年 6 月更新）。
//!
//! 颱風委員會 14 個成員各提供 10 個名字，共 140 個，分 5 組，依序往下用、用完再從頭開始。
//! 日本氣象廳和 GDACS 只有英文名稱，靠這張表補上中文；也提供給前端的名稱表頁面。

use axum::Json;
use serde::Serialize;

pub const UPDATED: &str = "2026-06";

/// 每一列是一個成員提供的名字，依第 1～5 組排列：`(中文, 國際命名)`
#[rustfmt::skip]
pub const NAMES: [(&str, [(&str, &str); 5]); 28] = [
    ("柬埔寨", [("丹瑞", "Damrey"), ("高基", "Koki"), ("娜克莉", "Nakri"), ("科羅旺", "Krovanh"), ("翠絲", "Trases")]),
    ("中國大陸", [("天馬", "Tianma"), ("銀杏", "Yinxing"), ("風神", "Fengshen"), ("杜鵑", "Dujuan"), ("木蘭", "Mulan")]),
    ("北韓", [("鴻雁", "Kirogi"), ("青蛙", "Gaeguri"), ("海鷗", "Kalmaegi"), ("舒力基", "Surigae"), ("米雷", "Meari")]),
    ("香港", [("鴛鴦", "Yun-yeung"), ("點心", "Dim-Sum"), ("鳳凰", "Fung-wong"), ("彩雲", "Choi-wan"), ("青馬", "Tsing-ma")]),
    ("日本", [("小犬", "Koinu"), ("希比", "Hebi"), ("天琴", "Koto"), ("小熊", "Koguma"), ("蝎虎", "Tokage")]),
    ("寮國", [("布拉萬", "Bolaven"), ("帕布", "Pabuk"), ("洛鞍", "Nokaen"), ("薔琵", "Champi"), ("坡鹿", "Ong-mang")]),
    ("澳門", [("三巴", "Sanba"), ("蝴蝶", "Wutip"), ("西望洋", "Penha"), ("煙花", "In-Fa"), ("梅花", "Muifa")]),
    ("馬來西亞", [("鯉魚", "Jelawat"), ("聖帕", "Sepat"), ("鸚鵡", "Nuri"), ("查帕卡", "Cempaka"), ("莫柏", "Merbok")]),
    ("米克羅尼西亞", [("蒂魯", "Tirou"), ("木恩", "Mun"), ("辛樂克", "Sinlaku"), ("尼伯特", "Nepartak"), ("南瑪都", "Nanmadol")]),
    ("菲律賓", [("馬力斯", "Maliksi"), ("丹娜絲", "Danas"), ("哈格比", "Hagupit"), ("盧碧", "Lupit"), ("塔拉斯", "Talas")]),
    ("南韓", [("凱米", "Gaemi"), ("百合", "Nari"), ("薔蜜", "Jangmi"), ("銀河", "Mirinae"), ("核桃", "Hodu")]),
    ("泰國", [("巴比侖", "Prapiroon"), ("薇帕", "Wipha"), ("米克拉", "Mekkhala"), ("妮妲", "Nida"), ("庫拉", "Kulap")]),
    ("美國", [("瑪莉亞", "Maria"), ("范斯高", "Francisco"), ("無花果", "Higos"), ("奧麥斯", "Omais"), ("洛克", "Roke")]),
    ("越南", [("山神", "Son-Tinh"), ("竹節草", "Co-may"), ("巴威", "Bavi"), ("布袋蓮", "Luc-Binh"), ("桑卡", "Sonca")]),
    ("柬埔寨", [("安比", "Ampil"), ("柯羅莎", "Krosa"), ("梅莎", "Maysak"), ("璨樹", "Chanthu"), ("尼莎", "Nesat")]),
    ("中國大陸", [("悟空", "Wukong"), ("白鹿", "Bailu"), ("海神", "Haishen"), ("電母", "Dianmu"), ("海棠", "Haitang")]),
    ("北韓", [("雲雀", "Jongdari"), ("楊柳", "Podul"), ("紅霞", "Noul"), ("蒲公英", "Mindulle"), ("蜻蜓", "Jamjari")]),
    ("香港", [("珊珊", "Shanshan"), ("玲玲", "Lingling"), ("白海豚", "Dolphin"), ("獅子山", "Lionrock"), ("榕樹", "Banyan")]),
    ("日本", [("船尾", "Tomo"), ("劍魚", "Kajiki"), ("鯨魚", "Kujira"), ("時鐘", "Tokei"), ("山貓", "Yamaneko")]),
    ("寮國", [("麗琵", "Leepi"), ("藍湖", "Nongfa"), ("昌鴻", "Chan-hom"), ("南修", "Namtheun"), ("帕卡", "Pakhar")]),
    ("澳門", [("貝碧佳", "Bebinca"), ("琵琶", "Peipah"), ("琵鷺", "Peilou"), ("瑪瑙", "Malou"), ("珊瑚", "Sanvu")]),
    ("馬來西亞", [("葡萄桑", "Pulasan"), ("塔巴", "Tapah"), ("南卡", "Nangka"), ("妮亞圖", "Nyatoh"), ("瑪娃", "Mawar")]),
    ("米克羅尼西亞", [("蘇力", "Soulik"), ("米塔", "Mitag"), ("沙德爾", "Saudel"), ("沙布爾", "Sarbul"), ("谷超", "Guchol")]),
    ("菲律賓", [("西馬隆", "Cimaron"), ("樺加沙", "Ragasa"), ("紫檀", "Narra"), ("阿穆丘", "Amuyao"), ("泰利", "Talim")]),
    ("南韓", [("娜尼", "Narae"), ("浣熊", "Neoguri"), ("簡拉維", "Gaenari"), ("古莎莉", "Gosari"), ("大麥", "Bori")]),
    ("泰國", [("布拉帕", "Burapha"), ("博羅依", "Bualoi"), ("閃電", "Atsani"), ("芙蓉", "Chaba"), ("卡努", "Khanun")]),
    ("美國", [("百里嘉", "Barijat"), ("麥德姆", "Matmo"), ("艾陶", "Etau"), ("艾利", "Aere"), ("蘭恩", "Lan")]),
    ("越南", [("花斑", "Hoaban"), ("哈隆", "Halong"), ("班朗", "Bang-lang"), ("桑達", "Songda"), ("海星", "Saobien")]),
];

/// 各家的拼法不太一樣（`IN-FA`、`In-fa`、`Infa`），比對時忽略大小寫、連字號和空白
fn key(name: &str) -> String {
    name.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect()
}

pub fn chinese_name(name_en: &str) -> Option<&'static str> {
    let wanted = key(name_en);
    NAMES.iter().flat_map(|(_, names)| names).find(|(_, en)| key(en) == wanted).map(|(zh, _)| *zh)
}

#[derive(Serialize)]
pub struct NameTable {
    pub updated: &'static str,
    pub rows: Vec<NameRow>,
}

#[derive(Serialize)]
pub struct NameRow {
    pub member: &'static str,
    /// 第 1～5 組
    pub names: Vec<Name>,
}

#[derive(Serialize)]
pub struct Name {
    pub zh: &'static str,
    pub en: &'static str,
}

pub async fn names() -> Json<NameTable> {
    let rows = NAMES
        .iter()
        .map(|(member, names)| NameRow { member, names: names.iter().map(|&(zh, en)| Name { zh, en }).collect() })
        .collect();
    Json(NameTable { updated: UPDATED, rows })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_chinese_names_regardless_of_spelling() {
        assert_eq!(chinese_name("IN-FA"), Some("煙花"));
        assert_eq!(chinese_name("In-fa"), Some("煙花"));
        assert_eq!(chinese_name("dim sum"), Some("點心"));
        assert_eq!(chinese_name("Vance"), None);
    }

    #[test]
    fn has_140_distinct_names() {
        let mut all: Vec<String> = NAMES.iter().flat_map(|(_, names)| names).map(|(_, en)| key(en)).collect();
        all.sort();
        all.dedup();
        assert_eq!(all.len(), 140);
    }
}
