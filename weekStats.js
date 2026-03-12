
const fs=require("fs")

const FILE="data/weekStats.json"

const WEEK539=["星期一","星期二","星期三","星期四","星期五","星期六"]
const WEEKT=["星期一","星期二","星期三","星期四","星期五","星期六","星期日"]

function load(){

 if(!fs.existsSync(FILE)){
  return {"539":{summary:{passed:0,fail:0,retry:0,x3:0},daily:{}},
          "ttl":{summary:{passed:0,fail:0,retry:0,x3:0},daily:{}}}
 }

 return JSON.parse(fs.readFileSync(FILE))
}

function save(d){
 fs.writeFileSync(FILE,JSON.stringify(d,null,2))
}

function weekday(){
 const map=["星期日","星期一","星期二","星期三","星期四","星期五","星期六"]
 return map[new Date().getDay()]
}

async function updateWeekStats(type,data){

 const stats=load()
 const day=weekday()

 stats[type].daily[day]=data.result

 if(data.result==="恭喜過關") stats[type].summary.passed++
 if(data.result==="沒過") stats[type].summary.fail++
 if(data.result==="再接再厲") stats[type].summary.retry++

 save(stats)
}

function buildWeeklyMessage(type){

 const stats=load()[type]
 const week=type==="539"?WEEK539:WEEKT

 let msg=`【${type} 本周統計】\n\n`
 msg+=`已過關：${stats.summary.passed}次\n`
 msg+=`沒過：${stats.summary.fail}次\n`
 msg+=`再接再厲：${stats.summary.retry}次\n`
 msg+=`靠3.3倍：${stats.summary.x3}次\n\n`

 week.forEach(d=>{
  msg+=`${d}：${stats.daily[d]||""}\n`
 })

 return msg
}

module.exports={updateWeekStats,buildWeeklyMessage}
