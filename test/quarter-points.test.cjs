const assert=require('node:assert/strict');
const {test}=require('node:test');
const {Collection,ChannelType}=require('discord.js');
const {pointsForTime}=require('../dist/reputation/daily-summary.js');
const {settleAttendance}=require('../dist/reputation/attendance-rules.js');
const {toPointUnits,fromPointUnits,formatPoints}=require('../dist/reputation/point-units.js');
const {eligibleVoiceUserIds,soloVoiceUserIds}=require('../dist/reputation/voice-tracking.js');
const {VoiceTracker}=require('../dist/reputation/voice-tracker.js');
const MINUTE=60000;
for(const [solo,group,expected] of [[10,0,0.25],[30,0,0.75],[40,0,1],[30,10,1.75],[5,1.25,0.25],[0,2.5,0.25],[9,0,0],[0,9,0.75]]){
  test(`${solo} solo minutes plus ${group} group minutes earn ${expected} points before bonuses`,()=>{
    assert.equal(pointsForTime((solo+group)*MINUTE,solo*MINUTE),expected);
  });
}
test('quarter units are exact, round-trip and format without floating artifacts',()=>{
  for(const points of [-500,-499.75,-0.25,0,0.25,1.75,4999.75,5000,6000]){
    assert.equal(fromPointUnits(toPointUnits(points)),points);
    assert.equal(formatPoints(points),points.toLocaleString('uk-UA',{maximumFractionDigits:2}));
  }
  for(const points of [0.1,NaN,Infinity,Number.MAX_SAFE_INTEGER,'1'])assert.throws(()=>toPointUnits(points));
  assert.throws(()=>fromPointUnits(1.5));
});
test('invalid solo totals cannot earn points',()=>{
  for(const solo of [-1,600001,NaN,0.1])assert.throws(()=>pointsForTime(600000,solo));
});
test('solo attendance keeps full attendance bonuses, tiny-visit streaks and fractional bounds',()=>{
  const state={balance:0,hasParticipated:true,attendanceStreak:2,absenceStreak:0};
  const result=settleAttendance(state,30*MINUTE,false,30*MINUTE);
  assert.equal(result.attendanceBonus,5);assert.equal(result.basePoints,0.75);assert.equal(result.points,5.75);
  assert.equal(result.attendanceStreak,3);
  assert.equal(settleAttendance(state,1,false,1).attendanceStreak,3);
  assert.equal(settleAttendance({...state,balance:4999.75},10*MINUTE,false,10*MINUTE).points,0.25);
  assert.equal(settleAttendance({...state,balance:-499.75,attendanceStreak:0,absenceStreak:7},0,false).points,-0.25);
});
function guild(states){
  return {afkChannelId:'afk',voiceStates:{cache:new Collection(states.map(([id,room,bot=false,known=true])=>[id,{
    id,channelId:room,channel:{type:room==='stage'?ChannelType.GuildStageVoice:ChannelType.GuildVoice},
    member:known?{user:{bot},isTracking:false}:null,selfMute:true,selfDeaf:true,
  }]))}};
}
test('company is per room: muted/deafened and paused humans count; bots/AFK/Stage/unknown members do not',()=>{
  const g=guild([['a','one'],['b','two'],['c','two'],['d','one',true],['e','afk'],['f','stage'],['g','one',false,false]]);
  assert.deepEqual(eligibleVoiceUserIds(g),['a','b','c']);assert.deepEqual(soloVoiceUserIds(g),['a']);
  g.voiceStates.cache.delete('c');assert.deepEqual(soloVoiceUserIds(g),['a','b']);
});
test('tracker checkpoints a rate change even when the eligible user set is unchanged',async()=>{
  let ms=0,present=['a'],solo=['a'];const writes=[];
  const tracker=new VoiceTracker({guildId:'guild',now:()=>new Date(ms),presentUserIds:()=>present,soloUserIds:()=>solo,
    store:{openRun:async()=>({runId:'run',pausedUserIds:[]}),checkpoint:async args=>writes.push(args),closeRun:async()=>{}}});
  await tracker.start();ms=5*MINUTE;present=['a','b'];solo=[];await tracker.observe();
  assert.deepEqual(writes[0].userIds,['a']);assert.deepEqual(writes[0].soloUserIds,['a']);
  ms=10*MINUTE;solo=['a','b'];await tracker.observe();
  assert.deepEqual(writes[1].userIds,['a','b']);assert.equal(writes[1].soloUserIds,undefined);
  ms=11*MINUTE;await tracker.observe();assert.equal(writes.length,2);
  ms=15*MINUTE;await tracker.checkpoint();assert.deepEqual(writes[2].soloUserIds,['a','b']);
  await tracker.stop();
});
test('recovery uses current room rates and never backfills an outage with stale group occupancy',async()=>{
  let ms=0,solo=[];const writes=[];let runs=0;
  const tracker=new VoiceTracker({guildId:'guild',now:()=>new Date(ms),presentUserIds:()=>['a'],soloUserIds:()=>solo,
    store:{openRun:async()=>({runId:`run-${++runs}`,pausedUserIds:[]}),checkpoint:async args=>writes.push(args),closeRun:async()=>{}}});
  await tracker.start();ms=MINUTE;await tracker.suspend();solo=['a'];ms=2*MINUTE;await tracker.start();
  ms=7*MINUTE;await tracker.checkpoint();assert.equal(writes.length,1);
  assert.equal(writes[0].from.getTime(),2*MINUTE);assert.deepEqual(writes[0].soloUserIds,['a']);
  await tracker.stop();
});
