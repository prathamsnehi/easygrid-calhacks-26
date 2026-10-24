/** Real sandbox smoke test. Run only in trusted terminal with server-side Nessie credentials. */
import {collectNessieEvidence} from '../src/finance-agent-workflow.ts';
const key=process.env.NESSIE_API_KEY;
const account=process.env.NESSIE_SANDBOX_ACCOUNT_ID;
if(!key||!account){
 console.error('Missing NESSIE_API_KEY / NESSIE_SANDBOX_ACCOUNT_ID in server environment. No request made.');
 process.exitCode=2;
}else{
 try{
  const result=await collectNessieEvidence({baseUrl:'https://api.nessieisreal.com/',apiKey:key,sandboxAccountId:account,fetcher:fetch});
  // Do not print credential, account ID, transaction IDs, personal info or URLs.
  console.log(JSON.stringify({provider:result.source,verified:result.accountVerified,
   transactions:result.transactions.length,readOnly:true,simulated:true},null,2));
 }catch(error){
  console.error('Sandbox verification failed:',error instanceof Error?error.message:'unknown error');
  process.exitCode=1;
 }
}
