export function StudioSplash({ waiting }: { waiting?: boolean }) {
  return (
    <div className="h-full w-full bg-neutral-950 flex items-center justify-center">
      {waiting ? (
        <div className="flex flex-col items-center gap-3 text-center px-6" role="status">
          <div className="w-4 h-4 rounded-full border-2 border-neutral-700 border-t-neutral-500 animate-spin motion-reduce:animate-none" />
          <p className="text-xs text-neutral-600">
            正在等待本地服务…请运行{" "}
            <code className="text-neutral-500 font-mono">chengfeng-videocut start</code>
          </p>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3 text-center px-6" role="status">
          <div className="w-4 h-4 rounded-full bg-studio-accent animate-pulse motion-reduce:animate-none" />
          <p className="text-xs text-neutral-600">正在连接项目…</p>
        </div>
      )}
    </div>
  );
}
