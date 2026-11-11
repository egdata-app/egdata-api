import {
  composeRenderProps,
  type FieldErrorProps,
  type InputProps,
  type LabelProps,
  FieldError as RACFieldError,
  Input as RACInput,
  Label as RACLabel,
  TextArea as RACTextArea,
  Text,
  type TextAreaProps,
  type TextProps,
} from "react-aria-components";
import { twMerge } from "tailwind-merge";
import { tv } from "tailwind-variants";
import { composeTailwindRenderProps, focusRing } from "./utils";

export function Label(props: LabelProps) {
  return (
    <RACLabel
      {...props}
      className={twMerge(
        "text-xs font-medium tracking-wide text-epic-text-muted cursor-default w-fit select-none",
        props.className,
      )}
    />
  );
}

export function Description(props: TextProps) {
  return (
    <Text
      {...props}
      slot="description"
      className={twMerge(
        "text-xs text-epic-text-muted/90 group-disabled:text-epic-text-disabled",
        props.className,
      )}
    />
  );
}

export function FieldError(props: FieldErrorProps) {
  return (
    <RACFieldError
      {...props}
      className={composeTailwindRenderProps(
        props.className,
        "text-xs text-epic-danger forced-colors:text-[Mark]",
      )}
    />
  );
}

export const inputStyles = tv({
  extend: focusRing,
  base: "border rounded-lg h-9 bg-epic-bg text-sm text-epic-text px-3 box-border transition-colors placeholder:text-epic-text-muted/60 disabled:opacity-50",
  variants: {
    isFocused: {
      false: "border-epic-border hover:border-epic-border-hover",
      true: "border-epic-accent",
    },
    isInvalid: {
      true: "border-epic-danger hover:border-epic-danger",
    },
  },
});

export const textAreaStyles = tv({
  extend: focusRing,
  base: "border rounded-lg min-h-24 bg-epic-bg text-sm text-epic-text p-3 box-border transition-colors placeholder:text-epic-text-muted/60 disabled:opacity-50",
  variants: {
    isFocused: {
      false: "border-epic-border hover:border-epic-border-hover",
      true: "border-epic-accent",
    },
    isInvalid: {
      true: "border-epic-danger hover:border-epic-danger",
    },
  },
});

export function Input(props: InputProps) {
  return (
    <RACInput
      {...props}
      className={composeRenderProps(props.className, (cls, renderProps) =>
        inputStyles({ ...renderProps, className: cls }),
      )}
    />
  );
}

export function TextArea(props: TextAreaProps) {
  return (
    <RACTextArea
      {...props}
      className={composeRenderProps(props.className, (cls, renderProps) =>
        textAreaStyles({ ...renderProps, className: cls }),
      )}
    />
  );
}
