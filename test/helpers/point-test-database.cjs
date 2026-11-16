// Legacy behavior fixtures are expressed in displayed points, not storage units.
// Only direct fixture model calls are encoded/decoded. Application stores MUST
// receive .raw; transactions also expose raw Prisma clients. New currency tests
// use the real client directly and assert actual persisted integer units.
const {createReputationDatabase: createRawDatabase}=require('../../dist/reputation/database.js');
const financialModels=new Set(['reputationMember','reputationSettlement','reputationDailyAward','reputationReport','reputationReportEntry','voiceReputationPoll']);
const financialFields=new Set(['balance','points','pointsAwarded','balanceAfter','balanceBefore','basePoints','attendanceBonus','absencePenalty','amount','appliedAmount','dailyPoints','voteRewards','votePenalties']);
function convert(value,factor,money=false){
  if(typeof value==='number')return money?value*factor:value;
  if(value===null||typeof value!=='object'||value instanceof Date)return value;
  if(Array.isArray(value))return value.map(item=>convert(item,factor,money));
  return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,key==='_count'?item:convert(item,factor,money||financialFields.has(key))]));
}
function createReputationDatabase(url){
  const raw=createRawDatabase(url),models=new Map();
  return new Proxy(raw,{
    get(target,key){
      if(key==='raw')return raw;
      const value=Reflect.get(target,key);
      if(financialModels.has(key)){
        if(!models.has(key))models.set(key,new Proxy(value,{
          get(model,operation){
            const method=Reflect.get(model,operation);
            if(typeof method!=='function')return method;
            return async args=>convert(await method.call(model,convert(args,4)),1/4);
          },
        }));
        return models.get(key);
      }
      return typeof value==='function'?value.bind(target):value;
    },
  });
}
module.exports={createReputationDatabase};
