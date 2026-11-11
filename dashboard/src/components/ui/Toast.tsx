import { X } from "lucide-react";
import type { CSSProperties } from "react";
import {
  Button,
  Text,
  UNSTABLE_Toast as Toast,
  UNSTABLE_ToastContent as ToastContent,
  UNSTABLE_ToastQueue as ToastQueue,
  UNSTABLE_ToastRegion as ToastRegion,
} from "react-aria-components";
import { flushSync } from "react-dom";

export interface ToastPayload {
  title: string;
  description?: string;
  tone?: "info" | "success" | "danger";
}

export const toastQueue = new ToastQueue<ToastPayload>({
  maxVisibleToasts: 4,
  wrapUpdate(fn) {
    if (typeof document !== "undefined" && "startViewTransition" in document) {
      document.startViewTransition(() => flushSync(fn));
    } else {
      fn();
    }
  },
});

export function notify(payload: ToastPayload) {
  toastQueue.add(payload, { timeout: 4500 });
}

export function AppToastRegion() {
  return (
    <ToastRegion
      queue={toastQueue}
      className="fixed bottom-4 right-4 z-50 flex flex-col-reverse gap-2 outline-0"
    >
      {({ toast }) => (
        <Toast
          toast={toast}
          style={{ viewTransitionName: toast.key } as CSSProperties}
          className="flex items-start gap-3 w-80 bg-epic-elevated border border-epic-border-hover shadow-2xl rounded-xl px-4 py-3 outline-0 focus-visible:outline-2 focus-visible:outline-epic-accent [view-transition-class:toast]"
        >
          <ToastContent className="flex flex-col gap-0.5 flex-1 min-w-0">
            <Text
              slot="title"
              className={
                toast.content.tone === "danger"
                  ? "text-sm font-semibold text-epic-danger"
                  : toast.content.tone === "success"
                    ? "text-sm font-semibold text-epic-success"
                    : "text-sm font-semibold text-epic-text"
              }
            >
              {toast.content.title}
            </Text>
            {toast.content.description && (
              <Text slot="description" className="text-xs text-epic-text-muted">
                {toast.content.description}
              </Text>
            )}
          </ToastContent>
          <Button
            slot="close"
            aria-label="Dismiss notification"
            className="p-1 rounded-md text-epic-text-muted hover:text-epic-text hover:bg-epic-hover outline-0 cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </Button>
        </Toast>
      )}
    </ToastRegion>
  );
}
