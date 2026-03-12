
const fs=require("fs")
const FILE="data/tracking.json"

function read(){
 if(!fs.existsSync(FILE)) return {}
 return JSON.parse(fs.readFileSync(FILE))
}

function write(d){
 fs.writeFileSync(FILE,JSON.stringify(d,null,2))
}

function setActiveTracking(type,data){
 const all=read()
 all[type]=data
 write(all)
}

function getActiveTracking(type){
 const all=read()
 return all[type]||null
}

module.exports={setActiveTracking,getActiveTracking}
