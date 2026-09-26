import { Component, type ErrorInfo, type ReactNode } from "react";
import { trackStudioEvent } from "../utils/studioTelemetry";
import { studioBootGuard } from "../bootstrap/studioBootGuard";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  recovering: boolean;
  recoveryMessage: string | null;
}

export class StudioErrorBoundary extends Component<Props, State> {
  state: State = { error: null, recovering: false, recoveryMessage: null };
  private recoveryInFlight = false;
  private disposed = false;

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidMount() {
    this.disposed = false;
  }

  componentWillUnmount() {
    this.disposed = true;
  }

  private recover = async () => {
    // Prevent duplicate navigation even before React commits the disabled state.
    if (this.recoveryInFlight) return;
    this.recoveryInFlight = true;
    this.setState({ recovering: true, recoveryMessage: null });
    try {
      const guard = studioBootGuard();
      if (!guard) {
        window.location.reload();
        return;
      }
      if (await guard.forceReload("react-error")) return;
      if (!this.disposed) {
        this.setState({ recoveryMessage: "本地服务暂时没有响应。请确认工作台服务已启动，再重新载入。" });
      }
    } catch {
      if (!this.disposed) {
        this.setState({ recoveryMessage: "重新载入未成功，请检查本地服务后再试。你的项目文件未被此操作修改。" });
      }
    }
    this.recoveryInFlight = false;
    if (!this.disposed) this.setState({ recovering: false });
  };

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[Studio] Uncaught error:", error, info.componentStack);
    trackStudioEvent("crash", {
      error_message: error.message,
      error_name: error.name,
      stack_trace: error.stack?.slice(0, 4000) ?? null,
      component_stack: info.componentStack?.slice(0, 2000) ?? null,
    });
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div data-studio-recovery="react-error" className="fixed inset-0 flex flex-col items-center justify-center gap-4 bg-neutral-950 font-sans text-neutral-200">
        <div className="text-lg font-semibold">工作台遇到了问题</div>
        <div className="max-w-[480px] text-center text-[13px] text-neutral-500">
          {this.state.error.message}
        </div>
        <p className="max-w-[480px] text-center text-[13px] text-neutral-400">
          可以先重试当前界面；若仍出错，请重新载入。尚未保存的界面修改可能丢失。
        </p>
        {this.state.recoveryMessage && <p role="alert">{this.state.recoveryMessage}</p>}
        <div className="mt-2 flex items-center gap-2">
          <button
            disabled={this.state.recovering}
            onClick={() => this.setState({ error: null, recoveryMessage: null })}
            className="rounded-md bg-studio-accent px-5 py-2 text-sm font-medium text-neutral-950 transition-[filter] hover:brightness-110 active:scale-[0.98]"
          >
            重试当前界面
          </button>
          <button
            disabled={this.state.recovering}
            onClick={this.recover}
            className="rounded-md border border-neutral-700 px-5 py-2 text-sm font-medium text-neutral-300 transition-colors hover:bg-neutral-800 active:scale-[0.98]"
          >
            {this.state.recovering ? "正在重新载入…" : "重新载入工作台"}
          </button>
        </div>
      </div>
    );
  }
}
