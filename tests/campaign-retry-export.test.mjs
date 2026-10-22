import test from 'node:test';
import assert from 'node:assert/strict';
import { rateLimitedContactsCsv } from '../src/lib/campaign-retry-export.ts';

test('retry export includes only currently rate-failed recipients and neutralizes spreadsheet formulas',()=>{
  const contact={phone:'+919000000001',name:'=DANGEROUS()'};
  const rate={status:'failed',error_message:'(#130429) Synthetic rate limit',contact};
  const csv=rateLimitedContactsCsv([rate,rate,
    {...rate,status:'delivered',contact:{...contact,phone:'+919000000002'}},
    {...rate,status:'sent',contact:{...contact,phone:'+919000000003'}},
    {...rate,status:'uncertain',contact:{...contact,phone:'+919000000004'}},
    {...rate,error_message:'(#131026) Undeliverable',contact:{...contact,phone:'+919000000005'}}]);
  assert.match(csv,/919000000001/);assert.match(csv,/'=DANGEROUS/);
  assert.equal(csv.split('919000000001').length-1,1);assert.doesNotMatch(csv,/91900000000[2-5]/);
  assert.equal(rateLimitedContactsCsv([{...rate,status:'read'}]),null);
});
