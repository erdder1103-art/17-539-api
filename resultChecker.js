
function hit(a,b){
 return a.filter(x=>b.includes(x)).length
}

async function checkResultAndUpdate(type,draw,tracking){

 const groups=tracking.groups
 const results={}

 Object.keys(groups).forEach(g=>{
  results[g]=hit(groups[g],draw)
 })

 let result="沒過"

 if(Object.values(results).some(v=>v>=3)) result="恭喜過關"
 else if(Object.values(results).some(v=>v==2)) result="再接再厲"

 return {
  type,
  draw,
  results,
  result
 }

}

module.exports={checkResultAndUpdate}
