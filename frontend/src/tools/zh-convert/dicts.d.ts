// opencc-js 的單一字典檔沒有附型別：內容是「詞 轉換|詞 轉換|…」的字串
declare module 'opencc-js/dict/*' {
  const dict: string
  export default dict
}
