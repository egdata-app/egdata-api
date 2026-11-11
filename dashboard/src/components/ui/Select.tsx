import { Check, ChevronDown } from "lucide-react";
import type React from "react";
import {
  Button,
  composeRenderProps,
  ListBox,
  ListBoxItem,
  type ListBoxItemProps,
  Select as RACSelect,
  type SelectProps as RACSelectProps,
  SelectValue,
  type ValidationResult,
} from "react-aria-components";
import { tv } from "tailwind-variants";
import { Description, FieldError, Label } from "./Field";
import { Popover } from "./Modal";
import { composeTailwindRenderProps, focusRing } from "./utils";

const triggerStyles = tv({
  extend: focusRing,
  base: "flex items-center text-start gap-2.5 w-full border border-epic-border hover:border-epic-border-hover rounded-lg pl-3 pr-2.5 h-9 min-w-[160px] transition bg-epic-bg hover:bg-epic-elevated pressed:bg-epic-hover text-epic-text cursor-pointer",
  variants: {
    isDisabled: {
      true: "opacity-50 cursor-not-allowed",
    },
  },
});

const itemStyles = tv({
  base: "group flex items-center justify-between gap-3 cursor-pointer select-none py-1.5 px-2.5 rounded-lg outline-0 text-sm text-epic-text transition-colors",
  variants: {
    isFocused: {
      true: "bg-epic-accent text-epic-accent-fg font-medium",
    },
    isDisabled: {
      true: "text-epic-text-disabled cursor-not-allowed",
    },
  },
});

export interface SelectProps<T extends object>
  extends Omit<RACSelectProps<T>, "children"> {
  label?: string;
  description?: string;
  errorMessage?: string | ((validation: ValidationResult) => string);
  items?: Iterable<T>;
  children: React.ReactNode | ((item: T) => React.ReactNode);
}

export function Select<T extends object>({
  label,
  description,
  errorMessage,
  children,
  items,
  ...props
}: SelectProps<T>) {
  return (
    <RACSelect
      {...props}
      className={composeTailwindRenderProps(
        props.className,
        "group flex flex-col gap-1.5 relative",
      )}
    >
      {label && <Label>{label}</Label>}
      <Button className={triggerStyles}>
        <SelectValue className="flex-1 text-sm truncate placeholder-shown:text-epic-text-muted" />
        <ChevronDown
          aria-hidden
          className="w-4 h-4 text-epic-text-muted shrink-0"
        />
      </Button>
      {description && <Description>{description}</Description>}
      <FieldError>{errorMessage}</FieldError>
      <Popover className="min-w-(--trigger-width)">
        <ListBox items={items} className="outline-0 p-1 max-h-64 overflow-auto">
          {children}
        </ListBox>
      </Popover>
    </RACSelect>
  );
}

export function SelectItem(props: ListBoxItemProps) {
  const textValue =
    props.textValue ||
    (typeof props.children === "string" ? props.children : undefined);
  return (
    <ListBoxItem {...props} textValue={textValue} className={itemStyles}>
      {composeRenderProps(props.children, (children, { isSelected }) => (
        <>
          <span className="truncate group-selected:font-semibold">
            {children}
          </span>
          {isSelected && <Check className="w-4 h-4 shrink-0" />}
        </>
      ))}
    </ListBoxItem>
  );
}
