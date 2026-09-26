import {test,expect} from "bun:test";
import {createConnectionApi} from "./connection-api";
test("connected read endpoints reject untrusted Host, Origin and nonloopback clients before project access",async()=>{
 const api=createConnectionApi("/unused",1234);
 for(const [host,origin,client] of [["evil.test:1234",null,"127.0.0.1"],["127.0.0.1:1234","http://evil.test","127.0.0.1"],["127.0.0.1:1234",null,"8.8.8.8"]] as const){
  const headers=new Headers({host});if(origin)headers.set("origin",origin);
  const response=await api(new Request("http://127.0.0.1:1234/api/v1/projects/demo/subtitle-inputs",{headers}),client);
  expect(response?.status).toBe(403);
 }
});

test("target reads reject foreign origins, methods and unbounded selectors before project access",async()=>{
 const api=createConnectionApi("/unused",1234),url="http://127.0.0.1:1234/api/v1/projects/demo/edit-targets";
 for(const [host,origin,client] of [["evil.test:1234",null,"127.0.0.1"],["127.0.0.1:1234","http://evil.test","127.0.0.1"],["127.0.0.1:1234",null,"8.8.8.8"]] as const){
  const headers=new Headers({host});if(origin)headers.set("origin",origin);
  expect((await api(new Request(url,{method:"POST",headers,body:'{"text":"test"}'}),client))?.status).toBe(403);
 }
 expect((await api(new Request(url,{headers:{host:"127.0.0.1:1234"}}),"127.0.0.1"))?.status).toBe(405);
 for(const body of ['{}','{"text":"x","clipIds":["c"]}',JSON.stringify({text:"x".repeat(32768)})]){
  const response=await api(new Request(url,{method:"POST",headers:{host:"127.0.0.1:1234"},body}),"127.0.0.1");
  expect(response?.status).toBe(400);expect((await response!.json()).error.code).toBe("invalid_argument");
 }
});
