function parts(date, timeZone) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23',
  }).formatToParts(date).filter(p=>p.type!=='literal').map(p=>[p.type,Number(p.value)]));
}

function localInstant(day, minutes, timeZone) {
  const desired=Date.UTC(day.year,day.month-1,day.day,Math.floor(minutes/60),minutes%60);
  let utc=desired;
  for(let i=0;i<5;i++){
    const p=parts(new Date(utc),timeZone);
    const actual=Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute,p.second);
    if(actual===desired) return new Date(utc);
    utc+=desired-actual;
  }
  throw new Error('Cycle reset time does not exist in this timezone on this date');
}

function shiftDay(day, offset) {
  const d=new Date(Date.UTC(day.year,day.month-1,day.day+offset));
  return {year:d.getUTCFullYear(),month:d.getUTCMonth()+1,day:d.getUTCDate()};
}

export function checkinCycle(origin, config={}, now=new Date()) {
  const rule=config.siteCycleRules?.[origin]??{};
  const timeZone=rule.timeZone??'Asia/Shanghai';
  const resetAt=rule.resetAt??'00:00';
  const match=/^([01]\d|2[0-3]):([0-5]\d)$/.exec(resetAt);
  if(!match) throw new Error('Cycle resetAt must use HH:mm');
  const p=parts(now,timeZone);
  const minutes=Number(match[1])*60+Number(match[2]);
  const day=shiftDay(p,p.hour*60+p.minute<minutes?-1:0);
  const start=localInstant(day,minutes,timeZone);
  const end=localInstant(shiftDay(day,1),minutes,timeZone);
  return {id:`${timeZone}|${resetAt}|${start.toISOString()}`,timeZone,resetAt,startAt:start.toISOString(),endAt:end.toISOString()};
}

export function isCurrentCheckinCycle(origin, observedAt, config={}, now=new Date()) {
  const observed=Date.parse(observedAt??'');
  if(!Number.isFinite(observed)||observed>now.getTime()) return false;
  const cycle=checkinCycle(origin,config,now);
  return observed>=Date.parse(cycle.startAt)&&observed<Date.parse(cycle.endAt);
}

export function expireCycleResult(result, config, now=new Date(), fallbackTimestamp) {
  if(!config.siteCycleRules?.[result.origin]||!['signed','already_signed'].includes(result.status)) return result;
  if(isCurrentCheckinCycle(result.origin,result.observedAt??result.evidence?.confirmedAt??fallbackTimestamp,config,now)) return result;
  return {origin:result.origin,title:result.title,folderNames:result.folderNames,status:'unconfirmed',reason:'站点已进入新的签到周期，需要重新确认',failureCode:'checkin_cycle_expired'};
}
