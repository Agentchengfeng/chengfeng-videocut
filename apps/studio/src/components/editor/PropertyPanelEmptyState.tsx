import { Eye, Layers } from "../../icons/SystemIcons";

export function PropertyPanelEmptyState({
  multiSelectCount,
}: {
  multiSelectCount: number;
}) {
  return (
    <div className="flex h-full flex-col bg-neutral-900">
      <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
        {multiSelectCount > 1 ? (
          <>
            <Layers size={18} className="mb-3 text-neutral-600" />
            <p className="text-sm font-medium text-neutral-200">
              已选择 {multiSelectCount} 个元素
            </p>
            <p className="mt-2 max-w-[260px] text-xs leading-5 text-neutral-500">
              选择单个元素后即可编辑属性。可以在预览画面或时间线图层中选择。
            </p>
          </>
        ) : (
          <>
            <Eye size={18} className="mb-3 text-neutral-600" />
            <p className="text-sm font-medium text-neutral-200">
              在画面中选择一个元素
            </p>
            <p className="mt-2 max-w-[260px] text-xs leading-5 text-neutral-500">
              选择后可调整位置、尺寸、颜色与动画参数。
            </p>
          </>
        )}
      </div>
    </div>
  );
}
