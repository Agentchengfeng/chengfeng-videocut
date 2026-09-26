import {test,expect} from "bun:test";
import {createHash} from "node:crypto";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {buildExportPlan} from "@video-workbench/core";
import {assembleCut,composeFilm,runFfmpeg,verifyFilm} from "./compose";
import {exportFilm} from "./index";
import {probeMedia} from "../mediaCut";

for(const windows of [[[.8,3]],[[.15,.91],[1.09,1.93],[2.11,2.89]]]) test(`fractional ${windows.length} source windows preserve exact planned frames`,async()=>{
 const root=await mkdtemp(join(tmpdir(),"fractional-export-"));
 try{
  const source=join(root,"source.mp4");
  await runFfmpeg(["-y","-v","error","-f","lavfi","-i","color=c=blue:s=64x64:r=24:d=3","-f","lavfi","-i","sine=frequency=440:duration=3","-c:v","libx264","-c:a","aac","-shortest",source]);
  let duration=0;const segments=windows.map(([start,end],i)=>{const timelineStart=duration;duration+=end!-start!;return {id:`a-${i}`,source:"source.mp4",sourceStart:start!,sourceEnd:end!,timelineStart,trackId:"a-roll" as const,playbackRate:1}});
  const plan=buildExportPlan({editList:{schemaVersion:1,projectId:"fixture",baseTranscriptRevision:"none",baseCutsRevision:"none",mode:"manual",sourceDuration:3,duration,segments},words:[],subtitles:null,visuals:null,source:{width:64,height:64,duration:3,frameRate:24},scale:1,fps:24});
  const assembled=join(root,"assembled.mkv");const output=join(root,"out.mp4");
  await assembleCut({source,output:assembled,plan});
  await composeFilm({assembled,framePattern:null,output,workDirectory:join(root,"work"),plan,profile:"fast"});
  const result=await verifyFilm(output,plan);expect(plan.frameCount).toBe(Math.round(duration*24));expect(result.frames).toBe(plan.frameCount);expect(result.problems).toEqual([]);expect(result.probe.hasAudio).toBe(true);
 }finally{await rm(root,{recursive:true,force:true})}
},15000);

async function mediaBytes(args: string[]): Promise<Buffer> {
  const child = Bun.spawn(["ffmpeg", "-v", "error", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code, error).toBe(0);
  return Buffer.from(output);
}

function decodePcm(path: string): Promise<Buffer> {
  return mediaBytes([
    "-i", path, "-map", "0:a:0", "-c:a", "pcm_s16le", "-f", "s16le", "pipe:1",
  ]);
}

for (const [width, height] of [[160,160], [90,160]]) test(`main-source contain into ${width}x${height} preserves square geometry`, async () => {
  const root = await mkdtemp(join(tmpdir(), "canvas-contain-proof-"));
  const source = join(root, "source.mp4"), output = join(root, "output.mp4"), assembled = join(root,"assembled.mkv");
  await runFfmpeg(["-y","-v","error","-f","lavfi","-i","color=blue:s=160x90:r=10:d=1,drawbox=x=60:y=25:w=40:h=40:color=white:t=fill","-f","lavfi","-i","sine=frequency=440:duration=1","-c:v","libx264","-c:a","aac","-shortest",source]);
  const hash = createHash("sha256").update(await readFile(source)).digest("hex");
  const input = {editList:{schemaVersion:1 as const,projectId:"fixture",baseTranscriptRevision:"none",baseCutsRevision:"none",mode:"manual" as const,sourceDuration:1,duration:1,segments:[{id:"one",source:"source.mp4",sourceStart:0,sourceEnd:1,timelineStart:0,trackId:"a-roll" as const,playbackRate:1}]},words:[],subtitles:null,visuals:null,source:{width:160,height:90,duration:1,frameRate:10},canvas:{width:width!,height:height!},scale:1};
  expect(() => buildExportPlan({...input,canvas:{width:Infinity,height:160}})).toThrow();
  const plan = buildExportPlan(input);
  expect(plan.source).toEqual({width:160,height:90});
  await assembleCut({source,output:assembled,plan});
  await composeFilm({assembled,framePattern:null,output,workDirectory:join(root,"work"),plan,profile:"fast"});
  expect((await verifyFilm(output,plan)).problems).toEqual([]);
  const pixels = await mediaBytes(["-i",output,"-frames:v","1","-pix_fmt","rgb24","-f","rawvideo","pipe:1"]);
  const points:number[][]=[];
  for(let y=0;y<height!;y++)for(let x=0;x<width!;x++){const i=(y*width!+x)*3;if(pixels[i]!>210&&pixels[i+1]!>210&&pixels[i+2]!>210)points.push([x,y]);}
  const xs=points.map(p=>p[0]!), ys=points.map(p=>p[1]!);
  const box={width:Math.max(...xs)-Math.min(...xs)+1,height:Math.max(...ys)-Math.min(...ys)+1};
  expect(Math.abs(box.width-box.height)).toBeLessThanOrEqual(2);
  expect(createHash("sha256").update(await readFile(source)).digest("hex")).toBe(hash);
  console.log("canvas-contain-proof",JSON.stringify({root,output,width,height,box,sourceSha256:hash}));
},15000);

const audioFixtures = [
  { windows: [[0.80025, 3]], width: 64, height: 96, scale: 1 },
  { windows: [[0.15025, 0.91075], [1.09025, 1.93375], [2.11025, 2.89175]], width: 96, height: 64, scale: 1.5 },
];

for (const fixture of audioFixtures) {
  test(`audio-only export preserves ${fixture.windows.length} fractional WAV windows and the planned canvas`, async () => {
    const root = await mkdtemp(join(tmpdir(), "audio-canvas-export-"));
    try {
      const source = join(root, "source.wav");
      const sampleRate = 48_000;
      const channels = 2;
      await runFfmpeg([
        "-y", "-v", "error", "-f", "lavfi",
        "-i", `sine=frequency=437:sample_rate=${sampleRate}:duration=3`,
        "-ac", String(channels), "-c:a", "pcm_s16le", source,
      ]);
      const originalHash = createHash("sha256").update(await readFile(source)).digest("hex");
      const sourceProbe = await probeMedia(source);
      expect(sourceProbe.hasVideo).toBe(false);
      expect(sourceProbe.hasAudio).toBe(true);
      const sourcePcm = await decodePcm(source);

      let duration = 0;
      const segments = fixture.windows.map(([start, end], index) => {
        const timelineStart = duration;
        duration += end! - start!;
        return {
          id: `audio-${index}`,
          source: "source.wav",
          sourceStart: start!,
          sourceEnd: end!,
          timelineStart,
          trackId: "a-roll" as const,
          playbackRate: 1,
        };
      });
      const plan = buildExportPlan({
        editList: {
          schemaVersion: 1,
          projectId: "audio-fixture",
          baseTranscriptRevision: "none",
          baseCutsRevision: "none",
          mode: "manual",
          sourceDuration: 3,
          duration,
          segments,
        },
        words: [],
        subtitles: null,
        visuals: null,
        source: { width: fixture.width, height: fixture.height, duration: 3, frameRate: 24 },
        scale: fixture.scale,
        fps: 24,
      });
      const workDirectory = join(root, "work");
      const outputPath = join(root, "out.mp4");
      const result = await exportFilm({
        projectDirectory: root,
        sourcePath: source,
        audioOnly: true,
        plan,
        outputPath,
        workDirectory,
        keepWork: true,
        profile: "fast",
      });
      expect(plan.frameCount).toBe(Math.round(duration * plan.fps));
      expect(result.frameCount).toBe(plan.frameCount);
      expect(result.problems).toEqual([]);
      expect(result.probe.hasVideo).toBe(true);
      expect(result.probe.hasAudio).toBe(true);
      expect(result.probe.width).toBe(plan.output.width);
      expect(result.probe.height).toBe(plan.output.height);

      const assembled = join(workDirectory, "assembled.mkv");
      const assembledResult = await verifyFilm(assembled, { ...plan, output: plan.source });
      expect(assembledResult.problems).toEqual([]);
      const bytesPerSample = channels * 2;
      const expectedPcm = Buffer.concat(fixture.windows.map(([start, end]) => sourcePcm.subarray(
        Math.round(start! * sampleRate) * bytesPerSample,
        Math.round(end! * sampleRate) * bytesPerSample,
      )));
      const assembledPcm = await decodePcm(assembled);
      expect(assembledPcm.length).toBe(expectedPcm.length);
      expect(assembledPcm.equals(expectedPcm)).toBe(true);
      expect((await decodePcm(outputPath)).some((byte) => byte !== 0)).toBe(true);
      const pixel = await mediaBytes([
        "-i", outputPath, "-map", "0:v:0", "-vf", "scale=1:1",
        "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1",
      ]);
      expect([...pixel]).toEqual([255, 255, 255]);
      expect(createHash("sha256").update(await readFile(source)).digest("hex")).toBe(originalHash);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);
}
