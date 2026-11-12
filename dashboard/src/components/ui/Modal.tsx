import type React from "react";
import {
  composeRenderProps,
  type DialogProps,
  DialogTrigger,
  Heading,
  ModalOverlay,
  type ModalOverlayProps,
  Dialog as RACDialog,
  Modal as RACModal,
  Popover as RACPopover,
  type PopoverProps as RACPopoverProps,
} from "react-aria-components";
import { twMerge } from "tailwind-merge";
import { tv } from "tailwind-variants";

const popoverStyles = tv({
  base: "bg-epic-elevated/95 backdrop-blur-xl shadow-2xl rounded-xl border border-epic-border-hover text-epic-text outline-0 overflow-auto z-50",
  variants: {
    isEntering: {
      true: "animate-in fade-in placement-bottom:slide-in-from-top-1 placement-top:slide-in-from-bottom-1 duration-150 ease-out",
    },
    isExiting: {
      true: "animate-out fade-out placement-bottom:slide-out-to-top-1 placement-top:slide-out-to-bottom-1 duration-100 ease-in",
    },
  },
});

export function Popover({
  children,
  className,
  ...props
}: Omit<RACPopoverProps, "children"> & { children: React.ReactNode }) {
  return (
    <RACPopover
      offset={6}
      {...props}
      className={composeRenderProps(className, (cls, renderProps) =>
        popoverStyles({ ...renderProps, className: cls }),
      )}
    >
      {children}
    </RACPopover>
  );
}

const overlayStyles = tv({
  base: "fixed inset-0 w-full h-dvh z-50 bg-black/75 backdrop-blur-xs flex items-center justify-center p-4 overflow-y-auto",
  variants: {
    isEntering: { true: "animate-in fade-in duration-150 ease-out" },
    isExiting: { true: "animate-out fade-out duration-150 ease-in" },
  },
});

const modalStyles = tv({
  base: "w-full rounded-2xl bg-epic-surface border border-epic-border-hover text-epic-text shadow-2xl overflow-hidden my-auto",
  variants: {
    size: {
      md: "max-w-md",
      lg: "max-w-xl",
      xl: "max-w-2xl",
    },
    isEntering: { true: "animate-in zoom-in-95 duration-150 ease-out" },
    isExiting: { true: "animate-out zoom-out-95 duration-150 ease-in" },
  },
  defaultVariants: {
    size: "lg",
  },
});

export function Modal({
  size = "lg",
  ...props
}: ModalOverlayProps & { size?: "md" | "lg" | "xl" }) {
  return (
    <ModalOverlay isDismissable {...props} className={overlayStyles}>
      <RACModal
        {...props}
        className={composeRenderProps(props.className, (cls, renderProps) =>
          modalStyles({ ...renderProps, size, className: cls }),
        )}
      />
    </ModalOverlay>
  );
}

export function Dialog(props: DialogProps) {
  return (
    <RACDialog
      {...props}
      className={twMerge(
        "outline-0 p-6 max-h-[85vh] overflow-y-auto relative",
        props.className,
      )}
    />
  );
}

export { DialogTrigger, Heading };
