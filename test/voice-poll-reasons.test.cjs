const assert = require('node:assert/strict');
const { test } = require('node:test');
const { ChannelType, MessageFlags, escapeMarkdown } = require('discord.js');
const { voicePenaltyCommand, voiceRewardCommand } = require('../dist/reputation/voice-poll-command.js');
const { normalizeVoicePollReason, VOICE_POLL_REASON_LIMIT } = require('../dist/reputation/voice-poll-store.js');
const { VoicePollRuntime } = require('../dist/reputation/voice-poll-runtime.js');
const { renderVoicePoll } = require('../dist/reputation/voice-poll-render.js');
const guildId='999999999999999999',caller='111111111111111111',target='222222222222222222';
const reason='За допомогу команді';
const poll=(kind,status,proposalReason=reason)=>({
  id:'11111111-1111-4111-8111-111111111111',guildId,kind,status,proposalReason,
  initiatorId:caller,targetId:target,voiceChannelId:'voice',amount:50,appliedAmount:20,noVoterIds:[],endsAt:null,
});
function fixture(command,input=reason) {
  const calls=[],replies=[];
  const interaction={guildId,channelId:'text',channel:{type:ChannelType.GuildText},user:{id:caller,bot:false},
    options:{getUser:()=>({id:target,bot:false}),getInteger:()=>50,getString:(name,required)=>{assert.equal(name,'reason');assert.equal(required,true);return input;}},
    client:{voicePolls:{create:async request=>{calls.push(request);return {...poll(command===voiceRewardCommand?'reward':'penalty','active'),textChannelId:'text',messageId:'message'};}}},
    deferReply:async payload=>replies.push(payload),editReply:async payload=>replies.push(payload),reply:async payload=>replies.push(payload),
  };
  return {interaction,calls,replies};
}

for (const command of [voicePenaltyCommand,voiceRewardCommand]) {
  test(`${command.data.name} requires a plain-text reason and passes the trimmed value privately`,async()=>{
    const data=command.data.toJSON();
    const option=data.options.find(option=>option.name==='reason');
    assert.equal(option.type,3);assert.equal(option.required,true);
    assert.equal(option.min_length,1);assert.equal(option.max_length,VOICE_POLL_REASON_LIMIT);
    const f=fixture(command,`  ${reason}\n`);await command.execute(f.interaction);
    assert.equal(f.calls[0].proposalReason,reason);
    assert.equal(f.replies[0].flags,MessageFlags.Ephemeral);
    assert.doesNotMatch(JSON.stringify(f.replies),new RegExp(reason));
  });
  test(`${command.data.name} rejects missing, blank and oversized reasons before reservation`,async()=>{
    for (const input of [null,undefined,'',' \t\n\u00a0 ','x'.repeat(1001)]) {
      const f=fixture(command,input); // Explicitly retain undefined rather than the fixture default.
      f.interaction.options.getString=()=>input;
      await command.execute(f.interaction);
      assert.equal(f.calls.length,0);assert.equal(f.replies[0].flags,MessageFlags.Ephemeral);
      assert.match(f.replies[1].content,/непорожню причину/);
    }
  });
}

test('reason validation preserves internal text and counts Unicode characters rather than UTF-16 units',()=>{
  assert.equal(normalizeVoicePollReason('\tперша\nдруга  '),'перша\nдруга');
  assert.equal(normalizeVoicePollReason('🙂'.repeat(1000)),'🙂'.repeat(1000));
  for (const input of [null,undefined,42,'\n\t','🙂'.repeat(1001)]) {
    assert.throws(()=>normalizeVoicePollReason(input),error=>error.code==='invalid-reason');
  }
});

test('runtime rejects blank reasons before tracker flushing, presence checks or database writes',async()=>{
  let work=0;
  const runtime=new VoicePollRuntime({guildId,store:{reserve:async()=>{work++;}},presence:{channelFor:()=>{work++;}},transport:{},beforeCreate:async()=>{work++;}});
  await assert.rejects(runtime.create({guildId,initiatorId:caller,targetId:target,textChannelId:'text',amount:50,proposalReason:'  '}),error=>error.code==='invalid-reason');
  assert.equal(work,0);await runtime.stop();
});

for (const kind of ['penalty','reward']) {
  test(`${kind} reasons are visible during voting and retained safely after success`,()=>{
    const text='**пояснення** @everyone <@123456789012345678>\nдругий рядок';
    for (const status of ['failed','cancelled']) {
      assert.doesNotMatch(JSON.stringify(renderVoicePoll(poll(kind,status,text))),/пояснення|другий рядок/);
    }
    for (const status of ['creating','active','succeeded']) {
      const result=renderVoicePoll(poll(kind,status,text));
      const description=result.embeds[0].toJSON().description;
      assert.ok(description.endsWith(`\n\n**Причина:** ${escapeMarkdown(text)}`));
      assert.deepEqual(result.allowedMentions,{parse:[]});
      if(status==='succeeded'){
        assert.ok(description.includes('**20**'));assert.deepEqual(result.components,[]);
      }else{
        assert.equal(result.components[0].components.length,2);
      }
    }
  });
}

test('legacy successful polls do not invent a reason; cancellation codes stay separate',()=>{
  const legacy=renderVoicePoll({...poll('penalty','succeeded',null),reason:'balance-floor'});
  assert.equal(legacy.embeds[0].toJSON().description,`<@${target}> втратив **20** балів репутації.`);
  const cancelled=renderVoicePoll({...poll('penalty','cancelled'),reason:'balance-floor'});
  assert.match(cancelled.embeds[0].toJSON().description,/−500/);
  assert.doesNotMatch(cancelled.embeds[0].toJSON().description,new RegExp(reason));
});

test('a maximum-length reason remains within Discord embed limits after Markdown escaping',()=>{
  for(const kind of ['penalty','reward'])for(const status of ['creating','active','succeeded']){
    const payload=renderVoicePoll(poll(kind,status,'*'.repeat(1000)));
    assert.ok(payload.embeds[0].toJSON().description.length<=4096);
  }
});
