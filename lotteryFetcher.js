
const fetch=require("node-fetch")

function pad(n){return String(n).padStart(2,"0")}

async function fetch539(){
 try{
  const r=await fetch("https://sc888.net/index.php?s=/LotteryFtn/index")
  const html=await r.text()
  const m=[...html.matchAll(/(\d{1,2})[^\d]+(\d{1,2})[^\d]+(\d{1,2})[^\d]+(\d{1,2})[^\d]+(\d{1,2})/g)]
  if(!m.length) return null
  return {issue:Date.now(),numbers:m[0].slice(1,6).map(pad)}
 }catch(e){
  return null
 }
}

async function fetchTTL(){
 return null
}

module.exports={fetch539,fetchTTL}
