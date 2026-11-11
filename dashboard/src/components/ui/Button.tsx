import {
  composeRenderProps,
  Button as RACButton,
  type ButtonProps as RACButtonProps,
} from "react-aria-components";
import { tv } from "tailwind-variants";
import { focusRing } from "./utils";

export interface ButtonProps extends RACButtonProps {
  variant?: "primary" | "secondary" | "destructive" | "quiet" | "icon";
  size?: "sm" | "md" | "lg";
}

export const buttonStyles = tv({
  extend: focusRing,
  base: "relative inline-flex items-center justify-center gap-2 shrink-0 font-sans font-medium text-center transition duration-150 rounded-lg border cursor-pointer select-none [-webkit-tap-highlight-color:transparent] pressed:scale-[0.98]",
  variants: {
    variant: {
      primary:
        "bg-epic-accent hover:bg-epic-accent-hover pressed:bg-epic-accent-pressed text-epic-accent-fg border-transparent font-semibold shadow-xs",
      secondary:
        "bg-epic-elevated hover:bg-epic-hover pressed:bg-epic-pressed text-epic-text border-epic-border hover:border-epic-border-hover",
      destructive:
        "bg-epic-danger/15 hover:bg-epic-danger/25 pressed:bg-epic-danger/35 text-epic-danger border-epic-danger/30",
      quiet:
        "border-transparent bg-transparent hover:bg-epic-elevated pressed:bg-epic-hover text-epic-text-muted hover:text-epic-text",
      icon: "border-transparent bg-transparent hover:bg-epic-elevated pressed:bg-epic-hover text-epic-text-muted hover:text-epic-text p-0 w-8 h-8 rounded-md",
    },
    size: {
      sm: "h-8 px-3 text-xs",
      md: "h-9 px-3.5 text-sm",
      lg: "h-10 px-5 text-sm",
    },
    isDisabled: {
      true: "opacity-50 cursor-not-allowed pressed:scale-100 pointer-events-none",
    },
    isPending: {
      true: "text-transparent cursor-wait",
    },
  },
  defaultVariants: {
    variant: "primary",
    size: "md",
  },
});

export function Button({ variant, size, ...props }: ButtonProps) {
  return (
    <RACButton
      {...props}
      className={composeRenderProps(props.className, (cls, renderProps) =>
        buttonStyles({ ...renderProps, variant, size, className: cls }),
      )}
    >
      {composeRenderProps(props.children, (children, { isPending }) => (
        <>
          {children}
          {isPending && (
            <span
              aria-hidden
              className="absolute inset-0 flex items-center justify-center"
            >
              <svg
                aria-hidden="true"
                className="w-4 h-4 motion-safe:animate-spin text-epic-text"
                viewBox="0 0 24 24"
                fill="none"
              >
                <circle
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="3"
                  className="opacity-25"
                />
                <path
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8v3a5 5 0 00-5 5H4z"
                />
              </svg>
            </span>
          )}
        </>
      ))}
    </RACButton>
  );
}
