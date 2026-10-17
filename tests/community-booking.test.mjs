import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

test('closing booking or transfer loading with x, Escape or backdrop cancels success and errors',async()=>{
  for(const action of ['open','reschedule'])for(const reason of ['x','esc','backdrop'])for(const fails of [false,true]){
    let resolve,reject;
    const pending=new Promise((yes,no)=>{resolve=yes;reject=no;});
    const sheets=[],toasts=[];
    let continued=0;
    const context={
      console,Date,setTimeout,clearTimeout,setInterval:()=>0,clearInterval(){},
      document:{createElement:()=>({}),head:{appendChild(){}},addEventListener(){}},
      PP:{esc:String,money:String,hhmm:String,ymd:d=>d.toISOString().slice(0,10),addDays:(d,n)=>new Date(+d+n*86400000)},
      PPUI:{sheet:options=>{sheets.push(options);return {close:r=>options.onClose?.(r)};},toast:(...args)=>toasts.push(args)},
      BookingAPI:{refreshAllAvailability:()=>pending,getBooking:async()=>({id:'booking-one',canReschedule:true}),settings:()=>{continued++;throw Error('Cancelled load continued into form');}},
      CommunityAPI:{},
    };
    context.window=context;
    vm.runInNewContext(readFileSync(new URL('../1-neon/booking.js',import.meta.url),'utf8'),context,{filename:'booking.js'});
    const opening=context.PPBooking[action]('booking-one');
    for(let tick=0;tick<5;tick++)await Promise.resolve();
    assert.equal(sheets.length,1,`${action} loading is visible`);
    sheets[0].onClose?.(reason);
    if(fails)reject(Error('Delayed network error'));else resolve([]);
    await assert.doesNotReject(opening,`${action}/${reason}/${fails}: closed load must stop`);
    assert.equal(continued,0);
    assert.equal(sheets.length,1,'no replacement sheet opens');
    assert.equal(toasts.length,0,'no late error toast after cancellation');
  }
});
