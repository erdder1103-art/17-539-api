
const fetch=require("node-fetch")

const TOKEN=process.env.BOT_TOKEN||""
const CHAT=process.env.TG_CHAT_ID||""

async function sendTelegramMessage(text){

 if(!TOKEN||!CHAT) throw new Error("缺少 BOT_TOKEN 或 TG_CHAT_ID")

 const url=`https://api.telegram.org/bot${TOKEN}/sendMessage`

 await fetch(url,{
  method:"POST",
  headers:{"Content-Type":"application/json"},
  body:JSON.stringify({chat_id:CHAT,text})
 })

}

module.exports={sendTelegramMessage}
