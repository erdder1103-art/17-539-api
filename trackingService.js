
const {setActiveTracking}=require("./trackingStore")
const {sendTelegramMessage}=require("./telegram")

async function confirmTracking(payload){

 const record={
  type:payload.lotteryType,
  groups:payload.groups,
  createdAt:new Date().toISOString()
 }

 setActiveTracking(payload.lotteryType,record)

 let msg="【確定通報】\n"
 Object.keys(payload.groups).forEach(k=>{
  msg+=k+"："+payload.groups[k].join("、")+"\n"
 })

 await sendTelegramMessage(msg)

 return {ok:true}
}

module.exports={confirmTracking}
