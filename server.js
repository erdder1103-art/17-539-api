
try{require('dotenv').config()}catch(e){}

const express=require("express")
const {confirmTracking}=require("./modules/trackingService")
const {getActiveTracking}=require("./modules/trackingStore")
const {checkResultAndUpdate}=require("./modules/resultChecker")
const {updateWeekStats,buildWeeklyMessage}=require("./modules/weekStats")
const {sendTelegramMessage}=require("./modules/telegram")
const {fetch539,fetchTTL}=require("./modules/lotteryFetcher")

const app=express()
const PORT=process.env.PORT||3000

app.use(express.json())
app.use(express.static("public"))

let last539=null
let lastTTL=null

async function cycle(){

 const r539=await fetch539()
 if(r539 && r539.issue!==last539){
   last539=r539.issue
   const tracking=getActiveTracking("539")
   if(tracking){
     const result=await checkResultAndUpdate("539",r539.numbers,tracking)
     await updateWeekStats("539",result)
   }
 }

 const ttl=await fetchTTL()
 if(ttl && ttl.issue!==lastTTL){
   lastTTL=ttl.issue
   const tracking=getActiveTracking("ttl")
   if(tracking){
     const result=await checkResultAndUpdate("ttl",ttl.numbers,tracking)
     await updateWeekStats("ttl",result)
   }
 }

}

setInterval(cycle,120000)

app.post("/api/confirm-tracking",async(req,res)=>{
 try{
  const r=await confirmTracking(req.body)
  res.json(r)
 }catch(e){
  res.status(400).json({ok:false,message:e.message})
 }
})

app.get("/api/weekly/:type",(req,res)=>{
 const msg=buildWeeklyMessage(req.params.type)
 res.json({message:msg})
})

app.listen(PORT,()=>{
 console.log("V4 system started",PORT)
})
