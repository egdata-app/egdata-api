import { Check, X } from "lucide-react";
import type React from "react";
import {
  Button,
  type CheckboxGroupProps,
  type CheckboxProps,
  composeRenderProps,
  Checkbox as RACCheckbox,
  CheckboxGroup as RACCheckboxGroup,
  Switch as RACSwitch,
  type SwitchProps as RACSwitchProps,
  Tag as RACTag,
  TagGroup as RACTagGroup,
  type TagGroupProps as RACTagGroupProps,
  type TagProps as RACTagProps,
  TagList,
  type TagListProps,
} from "react-aria-components";
import { tv } from "tailwind-variants";
import { Description, FieldError, Label } from "./Field";
import { composeTailwindRenderProps, focusRing } from "./utils";

const switchTrackStyles = tv({
  extend: focusRing,
  base: "flex h-5 w-9 px-0.5 items-center shrink-0 cursor-pointer rounded-full border transition duration-200",
  variants: {
    isSelected: {
      false: "bg-epic-elevated border-epic-border-hover",
      true: "bg-epic-accent border-epic-accent",
    },
    isDisabled: { true: "opacity-50 cursor-not-allowed" },
  },
});

const switchThumbStyles = tv({
  base: "h-3.5 w-3.5 rounded-full transition-transform duration-200",
  variants: {
    isSelected: {
      false: "translate-x-0 bg-epic-text-muted",
      true: "translate-x-4 bg-epic-accent-fg",
    },
  },
});

export function Switch({
  children,
  ...props
}: Omit<RACSwitchProps, "children"> & { children: React.ReactNode }) {
  return (
    <RACSwitch
      {...props}
      className={composeTailwindRenderProps(
        props.className,
        "group inline-flex gap-2.5 items-center text-sm text-epic-text disabled:text-epic-text-disabled cursor-pointer select-none",
      )}
    >
      {(renderProps) => (
        <>
          <div className={switchTrackStyles(renderProps)}>
            <span className={switchThumbStyles(renderProps)} />
          </div>
          {children}
        </>
      )}
    </RACSwitch>
  );
}

const checkboxBoxStyles = tv({
  extend: focusRing,
  base: "w-4 h-4 shrink-0 rounded-sm flex items-center justify-center border transition",
  variants: {
    isSelected: {
      false:
        "bg-epic-bg border-epic-border-hover group-pressed:border-epic-accent",
      true: "bg-epic-accent border-epic-accent text-epic-accent-fg",
    },
    isDisabled: {
      true: "opacity-50",
    },
  },
});

export function Checkbox({
  children,
  ...props
}: Omit<CheckboxProps, "children"> & { children: React.ReactNode }) {
  return (
    <RACCheckbox
      {...props}
      className={composeTailwindRenderProps(
        props.className,
        "group flex items-center gap-2 text-sm text-epic-text cursor-pointer select-none",
      )}
    >
      {(renderProps) => (
        <>
          <div className={checkboxBoxStyles(renderProps)}>
            {renderProps.isSelected && <Check className="w-3 h-3 stroke-[3]" />}
          </div>
          {children}
        </>
      )}
    </RACCheckbox>
  );
}

export function CheckboxGroup({
  label,
  description,
  children,
  ...props
}: Omit<CheckboxGroupProps, "children"> & {
  label?: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <RACCheckboxGroup
      {...props}
      className={composeTailwindRenderProps(
        props.className,
        "flex flex-col gap-2",
      )}
    >
      {label && <Label>{label}</Label>}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">{children}</div>
      {description && <Description>{description}</Description>}
      <FieldError />
    </RACCheckboxGroup>
  );
}

const tagStyles = tv({
  extend: focusRing,
  base: "inline-flex items-center gap-1.5 text-xs font-medium rounded-md border px-2.5 py-0.5 cursor-default select-none transition",
  variants: {
    tone: {
      neutral:
        "bg-epic-elevated text-epic-text-muted border-epic-border hover:border-epic-border-hover",
      accent: "bg-epic-accent-muted text-epic-accent border-epic-accent/30",
      success: "bg-epic-success/15 text-epic-success border-epic-success/30",
      warning: "bg-epic-warning/15 text-epic-warning border-epic-warning/30",
      danger: "bg-epic-danger/15 text-epic-danger border-epic-danger/30",
    },
    isSelected: {
      true: "bg-epic-accent text-epic-accent-fg border-transparent font-semibold",
    },
    allowsRemoving: {
      true: "pr-1",
    },
  },
  defaultVariants: { tone: "neutral" },
});

export function Badge({
  children,
  tone = "neutral",
  className,
}: {
  children: React.ReactNode;
  tone?: "neutral" | "accent" | "success" | "warning" | "danger";
  className?: string;
}) {
  return <span className={tagStyles({ tone, className })}>{children}</span>;
}

export function TagGroup<T extends object>({
  label,
  description,
  items,
  children,
  renderEmptyState,
  ...props
}: Omit<RACTagGroupProps, "children"> &
  Pick<TagListProps<T>, "items" | "children" | "renderEmptyState"> & {
    label?: string;
    description?: string;
  }) {
  return (
    <RACTagGroup {...props} className="flex flex-col gap-1.5">
      {label && <Label>{label}</Label>}
      <TagList
        items={items}
        renderEmptyState={renderEmptyState}
        className="flex flex-wrap gap-1.5"
      >
        {children}
      </TagList>
      {description && <Description>{description}</Description>}
    </RACTagGroup>
  );
}

export function TagItem({
  children,
  tone,
  ...props
}: RACTagProps & {
  tone?: "neutral" | "accent" | "success" | "warning" | "danger";
}) {
  const textValue = typeof children === "string" ? children : props.textValue;
  return (
    <RACTag
      textValue={textValue}
      {...props}
      className={composeRenderProps(props.className, (cls, renderProps) =>
        tagStyles({ ...renderProps, tone, className: cls }),
      )}
    >
      {composeRenderProps(children, (childContent, { allowsRemoving }) => (
        <>
          {childContent}
          {allowsRemoving && (
            <Button
              slot="remove"
              className="rounded-xs p-0.5 hover:bg-white/15 outline-0 cursor-pointer"
            >
              <X className="w-3 h-3" />
            </Button>
          )}
        </>
      ))}
    </RACTag>
  );
}

/** Standalone status/pill badge (safe outside <TagGroup>); use <TagItem> inside <TagGroup>. */
export const Tag = Badge;
