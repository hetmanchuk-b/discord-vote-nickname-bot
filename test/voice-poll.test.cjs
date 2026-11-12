const assert=require('node:assert/strict');
const {test}=require('node:test');
const {structuredClone}=globalThis;
const {setImmediate}=require('node:timers/promises');
const {Collection,ChannelType,MessageFlags}=require('discord.js');
const {VoicePollRuntime}=require('../dist/reputation/voice-poll-runtime.js');
const {DiscordVoicePollPresence,createVoicePollTransport}=require('../dist/reputation/voice-poll-discord.js');
const {renderVoicePoll}=require('../dist/reputation/voice-poll-render.js');
const {voicePenaltyCommand,voiceRewardCommand}=require('../dist/reputation/voice-poll-command.js');
const {handleButton}=require('../dist/buttons/index.js');
const {handleVoicePoll}=require('../dist/buttons/voice-poll.js');
const {handleChatInput}=require('../dist/interactions/chat-input.js');
const id='11111111-1111-4111-8111-111111111111';
const guildId='999999999999999999',target='111111111111111111',caller='222222222222222222',other='333333333333333333',fourth='444444444444444444';
const origin=Date.parse('2026-11-11T12:00:00Z');
const initial=()=>({id,guildId,kind:'penalty',targetId:target,initiatorId:caller,voiceChannelId:'voice',textChannelId:'text',amount:50,proposalReason:null,
  status:'creating',messageId:null,createdAt:new Date(origin),startedAt:null,endsAt:null,closedAt:null,appliedAmount:0,balanceAfter:null,noVoterIds:[],publishing:false,publishedAt:null,messageMissing:false});
function runtimeFixture(t,saved=null,beforeCreate){
  let at=origin;let poll=saved?structuredClone(saved):null;let dbDown=false;let lostAck=false;let verification=true;let found=null;
  const timers=[],evidence=[],edits=[],votes=[];let reserves=0,publishes=0,finished=0;
  const humans=new Set([target,caller,other,fourth]);
  t.mock.method(console,'warn',()=>{});
  t.mock.method(globalThis,'setTimeout',(callback,delay)=>{const timer={callback,delay,cancelled:false,unref(){}};timers.push(timer);return timer;});
  t.mock.method(globalThis,'clearTimeout',timer=>{if(timer)timer.cancelled=true;});
  const store={
    reserve:async request=>{reserves++;poll={...initial(),...request};return structuredClone(poll);},
    get:async()=>{if(dbDown)throw new Error('offline');return structuredClone(poll);},
    pending:async()=>poll&&!poll.publishedAt&&!poll.messageMissing?[structuredClone(poll)]:[],
    activate:async(_id,messageId,startedAt)=>{poll={...poll,messageId,startedAt,endsAt:new Date(startedAt.getTime()+120000),status:'active'};return structuredClone(poll);},
    cancel:async(_id,reason)=>{poll.status='cancelled';poll.reason=reason;poll.messageMissing=!poll.messageId;return structuredClone(poll);},
    vote:async request=>{votes.push(request);return request.yes;},
    finish:async(_id,observation)=>{evidence.push(structuredClone(observation));if(dbDown)throw new Error('offline');finished++;
      poll.status=observation?'succeeded':'cancelled';poll.appliedAmount=observation?50:0;return structuredClone(poll);},
    noteAttempt:async()=>{},prepareDelivery:async()=>{poll.publishing=true;return structuredClone(poll);},
    delivered:async(_id,missing)=>{poll.publishing=false;poll.messageMissing=missing;if(!missing)poll.publishedAt=new Date(at);},
  };
  const presence={channelFor:userId=>humans.has(userId)?'voice':null,humans:()=>[...humans],
    evidence:()=>verification?{at:new Date(at),userIds:[...humans]}:null};
  let shown='active';
  const transport={publish:async()=>{publishes++;found={id:'message',at:new Date(at)};return found;},find:async()=>found,
    inspect:async()=>shown,edit:async(_poll,payload)=>{edits.push(payload);shown='final';if(lostAck){lostAck=false;throw new Error('lost acknowledgement');}}};
  const runtime=new VoicePollRuntime({guildId,store,transport,presence,beforeCreate,now:()=>new Date(at)});
  return {runtime,humans,timers,evidence,edits,votes,store,
    at:ms=>{at=origin+ms;},dbDown:value=>{dbDown=value;},verify:value=>{verification=value;},loseAck:()=>{lostAck=true;},
    poll:()=>poll,missing:()=>{shown='missing';},reserves:()=>reserves,publishes:()=>publishes,finished:()=>finished,
    deadline:()=>timers.findLast(timer=>timer.delay===120000&&!timer.cancelled),
    retry:()=>timers.findLast(timer=>timer.delay===5000&&!timer.cancelled),
  };
}
const start=f=>f.runtime.create({guildId,initiatorId:caller,targetId:target,textChannelId:'text',amount:50,proposalReason:'Тестова причина'});
const settle=async()=>{for(let i=0;i<5;i++)await setImmediate();};

test('start needs four humans including both parties; target cannot vote and outsiders are rejected',async t=>{
  const f=runtimeFixture(t);f.humans.delete(fourth);
  await assert.rejects(start(f));assert.equal(f.reserves(),0);
  f.humans.add(fourth);const poll=await start(f);assert.equal(f.publishes(),1);
  const request={id:poll.id,guildId,textChannelId:'text',messageId:'message',userId:target,yes:true,interactionId:'200000000000000001'};
  await assert.rejects(f.runtime.vote(request));f.humans.delete(other);
  await assert.rejects(f.runtime.vote({...request,userId:other}));
  await f.runtime.vote({...request,userId:caller});await f.runtime.vote({...request,userId:caller,yes:false});
  assert.deepEqual(f.votes.map(v=>v.yes),[true,false]);await f.runtime.stop();
});

test('an available voice tracker is flushed before enrollment is checked',async t=>{
  let flushed=false;const f=runtimeFixture(t,null,async()=>{flushed=true;});
  const reserve=f.store.reserve;f.store.reserve=async request=>{assert.equal(flushed,true);return reserve(request);};
  await start(f);await f.runtime.stop();
});

test('deadline captures the original channel before awaits; only one remaining voter is sufficient',async t=>{
  const f=runtimeFixture(t);await start(f);f.humans.clear();f.humans.add(caller);
  f.at(120000);f.deadline().callback();await settle();
  assert.deepEqual(f.evidence[0].userIds,[caller]);assert.equal(f.finished(),1);assert.equal(f.poll().status,'succeeded');
  assert.equal(f.edits[0].components.length,0);await f.runtime.stop();
});

test('database failure at the deadline retains captured membership for later retry',async t=>{
  const f=runtimeFixture(t);await start(f);f.at(120000);f.dbDown(true);f.deadline().callback();await settle();
  f.humans.clear();f.dbDown(false);f.at(125000);f.retry().callback();await settle();
  assert.equal(f.evidence[0].userIds.length,4);assert.equal(f.evidence[0].at.getTime(),origin+120000);
  assert.equal(f.finished(),1);await f.runtime.stop();
});

test('restart before deadline resumes the saved poll without publishing a duplicate',async t=>{
  const saved={...initial(),status:'active',messageId:'message',startedAt:new Date(origin),endsAt:new Date(origin+120000)};
  const f=runtimeFixture(t,saved);f.at(60000);await f.runtime.refresh();assert.equal(f.publishes(),0);
  const timer=f.timers.findLast(item=>item.delay===60000);assert.ok(timer);
  f.at(120000);timer.callback();await settle();assert.equal(f.finished(),1);await f.runtime.stop();
});

test('restart after an unverifiable deadline cancels without a fine',async t=>{
  const saved={...initial(),status:'active',messageId:'message',endsAt:new Date(origin+120000)};
  const f=runtimeFixture(t,saved);f.at(130000);f.verify(false);await f.runtime.refresh();await settle();
  assert.equal(f.poll().status,'cancelled');assert.equal(f.poll().appliedAmount,0);await f.runtime.stop();
});

test('lost final Discord acknowledgement reconciles the same message without another fine',async t=>{
  const f=runtimeFixture(t);await start(f);f.loseAck();f.at(120000);f.deadline().callback();await settle();
  f.at(125000);f.retry().callback();await settle();assert.equal(f.finished(),1);assert.equal(f.edits.length,1);assert.ok(f.poll().publishedAt);await f.runtime.stop();
});

test('a deleted poll message cancels without imposing a fine',async t=>{
  const f=runtimeFixture(t);await start(f);f.missing();f.at(120000);f.deadline().callback();await settle();
  assert.equal(f.finished(),0);assert.equal(f.poll().status,'cancelled');assert.equal(f.poll().messageMissing,true);await f.runtime.stop();
});

test('abandoned creation reservations are cancelled rather than blindly reposted',async t=>{
  const f=runtimeFixture(t,initial());f.at(6000);await f.runtime.refresh();await settle();assert.equal(f.publishes(),0);assert.equal(f.poll().status,'cancelled');await f.runtime.stop();
});

function presenceFixture(){
  let at=origin;let ready=true;const voice={type:ChannelType.GuildVoice,permissionsFor:()=>({has:()=>true})};
  const states=new Map([target,caller,other,fourth].map(id=>[id,{id,channelId:'voice',channel:voice,member:{user:{bot:false}}}]));
  const guild={id:guildId,available:true,members:{me:{id:'bot'}},channels:{cache:new Map([['voice',voice]])},voiceStates:{cache:states}};
  const client={isReady:()=>ready,guilds:{cache:new Map([[guildId,guild]])}};
  const presence=new DiscordVoicePollPresence(client,guildId,()=>new Date(at));presence.online();
  return {presence,states,guild,at:ms=>{at=origin+ms;},ready:value=>{ready=value;}};
}

test('presence reconstructs deadline membership rather than counting a late join or dropping a late leaver',()=>{
  const f=presenceFixture();const deadline=new Date(origin+120000);f.at(120100);
  f.states.delete(other);f.presence.observe({guild:f.guild,id:other,channelId:'voice',member:{user:{bot:false}}},{guild:f.guild,id:other,channelId:null,member:{user:{bot:false}}});
  const late='777777777777777777';f.states.set(late,{id:late,channelId:'voice',member:{user:{bot:false}}});
  f.presence.observe({guild:f.guild,id:late,channelId:null,member:{user:{bot:false}}},{guild:f.guild,id:late,channelId:'voice',member:{user:{bot:false}}});
  const evidence=f.presence.evidence('voice',deadline);assert.ok(evidence.userIds.includes(other));assert.ok(!evidence.userIds.includes(late));
});

test('target departure does not invalidate the deadline even when their member data disappeared',()=>{
  const f=presenceFixture();f.states.delete(target);f.at(120100);
  f.presence.observe({guild:f.guild,id:target,channelId:'voice',member:null},{guild:f.guild,id:target,channelId:null,member:null});
  const evidence=f.presence.evidence('voice',new Date(origin+120000),target);
  assert.ok(evidence);assert.ok(!evidence.userIds.includes(target));assert.ok(evidence.userIds.includes(caller));
});

test('offline deadlines, long event-loop stalls, and unknown voice members are unverifiable',()=>{
  const f=presenceFixture();const deadline=new Date(origin+120000);
  f.presence.offline();f.at(120100);f.presence.online();assert.equal(f.presence.evidence('voice',deadline),null);
  const g=presenceFixture();g.at(122001);assert.equal(g.presence.evidence('voice',deadline),null);
  const h=presenceFixture();h.at(120000);h.states.get(other).member=null;assert.equal(h.presence.evidence('voice',deadline),null);
});

test('bots are excluded and losing access to the original voice channel prevents a fine',()=>{
  const f=presenceFixture();const bot='888888888888888888';
  f.states.set(bot,{id:bot,channelId:'voice',channel:f.guild.channels.cache.get('voice'),member:{user:{bot:true}}});
  assert.equal(f.presence.humans('voice').length,4);assert.equal(f.presence.channelFor(bot),null);
  f.at(120000);f.guild.channels.cache.get('voice').permissionsFor=()=>({has:()=>false});
  assert.equal(f.presence.evidence('voice',new Date(origin+120000)),null);
});

test('rendering never shows vote counts or Yes identities and only exposes No identities on failure',()=>{
  const poll=initial();const opened=renderVoicePoll(poll);const text=JSON.stringify(opened);
  assert.equal(opened.embeds[0].toJSON().fields,undefined);assert.equal(opened.components[0].components.length,2);
  assert.doesNotMatch(text,/noVoterIds|кількість|votes/);
  const failed=renderVoicePoll({...poll,status:'failed',noVoterIds:[other]});assert.match(failed.embeds[0].toJSON().description,new RegExp(other));assert.doesNotMatch(failed.embeds[0].toJSON().description,new RegExp(caller));
  const success=renderVoicePoll({...poll,status:'succeeded',appliedAmount:20,noVoterIds:[other]});assert.equal(success.embeds[0].toJSON().description,`<@${target}> втратив **20** балів репутації.`);
  assert.deepEqual(success.allowedMentions,{parse:[]});
  const large=renderVoicePoll({...poll,status:'failed',noVoterIds:Array.from({length:100},(_,i)=>String(100000000000000000n+BigInt(i)))});
  assert.ok(large.embeds[0].toJSON().description.length<=4096);assert.equal(large.files.length,1);
});

test('command uses ephemeral validation/confirmation and exposes exactly the three fine choices',async()=>{
  const data=voicePenaltyCommand.data.toJSON();assert.equal(data.name,'voice-penalty');assert.equal(data.dm_permission,false);assert.equal(voicePenaltyCommand.cooldown,0);
  assert.deepEqual(data.options[1].choices.map(item=>item.value),[10,50,100]);
  const replies=[],calls=[];const interaction={guildId,channel:{type:ChannelType.GuildText},channelId:'text',user:{id:caller,bot:false},
    options:{getUser:()=>({id:target,bot:false}),getInteger:()=>50,getString:()=> 'Тестова причина'},client:{voicePolls:{create:async request=>{calls.push(request);return {...initial(),status:'active',messageId:'message'};}}},
    deferReply:async payload=>replies.push(payload),editReply:async payload=>replies.push(payload),reply:async payload=>replies.push(payload)};
  await voicePenaltyCommand.execute(interaction);assert.equal(replies[0].flags,MessageFlags.Ephemeral);assert.equal(calls[0].amount,50);
  interaction.options.getUser=()=>({id:caller,bot:false});await voicePenaltyCommand.execute(interaction);assert.equal(replies.at(-1).flags,MessageFlags.Ephemeral);assert.equal(calls.length,1);
});

test('button confirmations are private and changed selections pass the same poll/message identity',async()=>{
  const calls=[],replies=[];const interaction={id:'200000000000000001',customId:`voice-penalty:${id}:yes`,guildId,channelId:'text',message:{id:'message'},user:{id:caller,bot:false},
    client:{voicePolls:{vote:async request=>{calls.push(request);return request.yes;}}},deferReply:async payload=>replies.push(payload),editReply:async payload=>replies.push(payload),reply:async payload=>replies.push(payload)};
  await handleVoicePoll(interaction);interaction.customId=`voice-penalty:${id}:no`;await handleVoicePoll(interaction);
  assert.deepEqual(calls.map(call=>call.yes),[true,false]);assert.equal(calls[0].messageId,'message');assert.equal(replies[0].flags,MessageFlags.Ephemeral);
  interaction.customId='voice-penalty:invalid:yes';await handleVoicePoll(interaction);assert.equal(calls.length,2);
});

test('Discord transport adopts the same marker, validates authors, and reports a vanished channel as missing',async()=>{
  const messages=new Collection();const events=[];const guild={id:guildId,available:true,members:{me:{id:'bot'}},voiceStates:{cache:new Map([target,caller,other,fourth].map(id=>[id,{channelId:'voice',member:{id,user:{bot:false}}}]))}};
  const destination={guildId,type:ChannelType.GuildText,guild,permissionsFor:()=>({has:()=>true}),
    messages:{fetch:async request=>typeof request==='string'?messages.get(request):messages,edit:async()=>events.push('edit')},
    send:async payload=>{events.push('send');assert.equal(payload.enforceNonce,true);assert.deepEqual(payload.allowedMentions,{parse:[]});
      const message={id:'message',createdAt:new Date(origin),author:{id:'bot'},embeds:payload.embeds.map(embed=>embed.toJSON())};messages.set(message.id,message);return message;}};
  guild.channels={fetch:async()=>destination};
  const client={user:{id:'bot'},guilds:{cache:new Map([[guildId,guild]])}};
  const transport=createVoicePollTransport(client,guildId);const poll=initial();
  const sent=await transport.publish(poll,()=>events.push('check-voice'));
  assert.deepEqual(events,['check-voice','send']);assert.equal(sent.at.getTime(),origin);
  const adopted=await transport.find(poll);assert.equal(adopted.id,sent.id);
  const active={...poll,status:'active',messageId:'message'};assert.equal(await transport.inspect(active),'active');
  messages.get('message').author.id='different-bot';await assert.rejects(transport.edit(active,renderVoicePoll(active)));assert.equal(events.includes('edit'),false);
  destination.permissionsFor=member=>({has:()=>member.id!==other});
  await assert.rejects(transport.publish({...poll,id:'22222222-2222-4222-8222-222222222222'}));
  assert.equal(events.filter(event=>event==='send').length,1); // No hidden-channel poll.
  guild.channels.fetch=async()=>null;assert.equal(await transport.inspect(active),'missing');
});

test('voice-reward command shares eligibility and choices but reserves a reward privately',async()=>{
  const data=voiceRewardCommand.data.toJSON();assert.equal(data.name,'voice-reward');assert.equal(data.dm_permission,false);assert.equal(voiceRewardCommand.cooldown,0);
  assert.deepEqual(data.options[1].choices.map(choice=>choice.value),[10,50,100]);
  const replies=[],calls=[];const interaction={guildId,channel:{type:ChannelType.GuildText},channelId:'text',user:{id:caller,bot:false},
    options:{getUser:()=>({id:target,bot:false}),getInteger:()=>100,getString:()=> 'Тестова причина'},client:{voicePolls:{create:async request=>{calls.push(request);return {...initial(),kind:'reward',status:'active',messageId:'message'};}}},
    deferReply:async payload=>replies.push(payload),editReply:async payload=>replies.push(payload),reply:async payload=>replies.push(payload)};
  await voiceRewardCommand.execute(interaction);assert.equal(calls[0].kind,'reward');assert.equal(calls[0].amount,100);assert.equal(replies[0].flags,MessageFlags.Ephemeral);
  interaction.options.getUser=()=>({id:caller,bot:false});await voiceRewardCommand.execute(interaction);assert.equal(calls.length,1);assert.equal(replies.at(-1).flags,MessageFlags.Ephemeral);
});

test('reward rendering uses reward buttons and actual credited amount without exposing Yes identities or totals',()=>{
  const poll={...initial(),kind:'reward'};const open=renderVoicePoll(poll);
  assert.match(open.embeds[0].toJSON().description,/нагороду/);assert.equal(open.components[0].components[0].data.custom_id,`voice-reward:${id}:yes`);
  const success=renderVoicePoll({...poll,status:'succeeded',appliedAmount:20,noVoterIds:[other]});
  assert.equal(success.embeds[0].toJSON().description,`<@${target}> отримав **20** балів репутації.`);assert.deepEqual(success.allowedMentions,{parse:[]});assert.equal(success.components.length,0);
  const failed=renderVoicePoll({...poll,status:'failed',noVoterIds:[other]});assert.match(failed.embeds[0].toJSON().description,/щодо нагороди/);assert.match(failed.embeds[0].toJSON().description,new RegExp(other));assert.doesNotMatch(failed.embeds[0].toJSON().description,new RegExp(caller));
  const cancelled=renderVoicePoll({...poll,status:'cancelled',reason:'balance-ceiling'});assert.match(cancelled.embeds[0].toJSON().description,/5 000/);
});

test('reward polls use the existing durable runtime and final presence workflow',async t=>{
  const f=runtimeFixture(t);const poll=await f.runtime.create({guildId,initiatorId:caller,targetId:target,textChannelId:'text',amount:50,proposalReason:'Тестова причина',kind:'reward'});
  assert.equal(poll.kind,'reward');await assert.rejects(f.runtime.vote({id:poll.id,guildId,textChannelId:'text',messageId:'message',userId:caller,yes:true,interactionId:'200000000000000001',kind:'penalty'}));
  await f.runtime.vote({id:poll.id,guildId,textChannelId:'text',messageId:'message',userId:caller,yes:true,interactionId:'200000000000000002',kind:'reward'});
  f.at(120000);f.deadline().callback();await settle();assert.equal(f.finished(),1);assert.match(f.edits[0].embeds[0].toJSON().description,/отримав/);await f.runtime.stop();
});

test('reward button routing preserves private changeable votes and binds the reward kind',async()=>{
  const calls=[],replies=[];const interaction={id:'200000000000000001',customId:`voice-reward:${id}:yes`,guildId,channelId:'text',message:{id:'message'},user:{id:caller,bot:false},
    client:{voicePolls:{vote:async request=>{calls.push(request);return request.yes;}}},deferReply:async payload=>replies.push(payload),editReply:async payload=>replies.push(payload),reply:async payload=>replies.push(payload)};
  await handleButton(interaction);interaction.customId=`voice-reward:${id}:no`;await handleButton(interaction);
  assert.deepEqual(calls.map(call=>[call.kind,call.id,call.yes]),[['reward',id,true],['reward',id,false]]);assert.equal(replies[0].flags,MessageFlags.Ephemeral);
});

test('restart retains the visible voting reason and keeps it after successful finalization',async t=>{
  const proposalReason='Допомога команді після перезапуску';
  const saved={...initial(),kind:'reward',proposalReason,status:'active',messageId:'message',startedAt:new Date(origin),endsAt:new Date(origin+120000)};
  const f=runtimeFixture(t,saved);f.at(60000);await f.runtime.refresh();
  assert.equal(f.publishes(),0);assert.equal(f.edits.length,0);
  assert.ok(renderVoicePoll(f.poll()).embeds[0].toJSON().description.endsWith(`**Причина:** ${proposalReason}`));
  const timer=f.timers.findLast(item=>item.delay===60000);
  f.at(120000);timer.callback();await settle();
  assert.ok(f.edits[0].embeds[0].toJSON().description.endsWith(`**Причина:** ${proposalReason}`));
  await f.runtime.stop();
});

test('a zero-cooldown command does not create a generic dispatcher cooldown',async()=>{
  let calls=0;const interaction={commandName:'voice-penalty',user:{id:caller},client:{commands:new Map([['voice-penalty',{data:{name:'voice-penalty'},cooldown:0,execute:async()=>calls++}]]),cooldowns:new Collection()},reply:async()=>{throw new Error('Unexpected cooldown');}};
  await handleChatInput(interaction);await handleChatInput(interaction);assert.equal(calls,2);
});
