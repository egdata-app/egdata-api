import {
  type CellProps,
  Collection,
  type ColumnProps,
  composeRenderProps,
  Group,
  Cell as RACCell,
  Column as RACColumn,
  Row as RACRow,
  Tab as RACTab,
  TabList as RACTabList,
  Table as RACTable,
  TableBody as RACTableBody,
  TableHeader as RACTableHeader,
  TabPanel as RACTabPanel,
  Tabs as RACTabs,
  type RowProps,
  SelectionIndicator,
  type TabListProps,
  type TableBodyProps,
  type TableHeaderProps,
  type TableProps,
  type TabPanelProps,
  type TabProps,
  type TabsProps,
} from "react-aria-components";
import { twMerge } from "tailwind-merge";
import { tv } from "tailwind-variants";
import { composeTailwindRenderProps, focusRing } from "./utils";

export function Tabs(props: TabsProps) {
  return (
    <RACTabs
      {...props}
      className={composeTailwindRenderProps(
        props.className,
        "flex flex-col orientation-vertical:flex-row gap-4 w-full",
      )}
    />
  );
}

export function TabList<T extends object>(props: TabListProps<T>) {
  return (
    <RACTabList
      {...props}
      className={composeTailwindRenderProps(
        props.className,
        "flex border-b border-epic-border gap-1 overflow-x-auto [scrollbar-width:none]",
      )}
    />
  );
}

const tabStyles = tv({
  extend: focusRing,
  base: "relative px-3.5 py-2.5 text-sm font-medium text-epic-text-muted hover:text-epic-text selected:text-epic-text cursor-pointer transition-colors select-none outline-offset-[-2px]",
  variants: {
    isDisabled: { true: "text-epic-text-disabled cursor-not-allowed" },
  },
});

export function Tab(props: TabProps) {
  return (
    <RACTab
      {...props}
      className={composeRenderProps(props.className, (cls, renderProps) =>
        tabStyles({ ...renderProps, className: cls }),
      )}
    >
      {composeRenderProps(props.children, (children) => (
        <>
          {children}
          <SelectionIndicator className="absolute bottom-0 left-0 right-0 h-[2px] bg-epic-accent rounded-t-full motion-safe:transition-[translate,width] duration-200" />
        </>
      ))}
    </RACTab>
  );
}

export function TabPanel(props: TabPanelProps) {
  return (
    <RACTabPanel
      {...props}
      className={composeTailwindRenderProps(props.className, "outline-0 pt-2")}
    />
  );
}

export function Table({
  className,
  ...props
}: Omit<TableProps, "className"> & { className?: string }) {
  return (
    <div
      className={twMerge(
        "w-full overflow-x-auto relative bg-epic-surface border border-epic-border rounded-xl",
        className,
      )}
    >
      <RACTable
        {...props}
        className="w-full border-separate border-spacing-0 text-sm"
      />
    </div>
  );
}

export function TableHeader<T extends object>({
  columns,
  children,
  ...props
}: TableHeaderProps<T>) {
  return (
    <RACTableHeader
      {...props}
      className={composeTailwindRenderProps(
        props.className,
        "bg-epic-elevated/90 backdrop-blur-md",
      )}
    >
      {columns ? <Collection items={columns}>{children}</Collection> : children}
    </RACTableHeader>
  );
}

export function Column(props: ColumnProps) {
  return (
    <RACColumn
      {...props}
      className={composeTailwindRenderProps(
        props.className,
        "text-start text-[11px] font-semibold uppercase tracking-wider text-epic-text-muted border-b border-epic-border px-4 py-3 select-none cursor-default",
      )}
    >
      {composeRenderProps(props.children, (children) => (
        <Group
          role="presentation"
          tabIndex={-1}
          className="flex items-center gap-1.5 outline-0"
        >
          <span className="truncate">{children}</span>
        </Group>
      ))}
    </RACColumn>
  );
}

const rowStyles = tv({
  extend: focusRing,
  base: "group/row relative text-epic-text hover:bg-epic-elevated/50 selected:bg-epic-accent-muted transition-colors -outline-offset-2",
});

export function Row<T extends object>({
  id,
  columns,
  children,
  ...props
}: RowProps<T>) {
  return (
    <RACRow id={id} {...props} className={rowStyles}>
      {columns ? <Collection items={columns}>{children}</Collection> : children}
    </RACRow>
  );
}

export function Cell(props: CellProps) {
  return (
    <RACCell
      {...props}
      className={composeTailwindRenderProps(
        props.className,
        "px-4 py-3 border-b border-epic-border/70 group-last/row:border-b-0 align-middle outline-0",
      )}
    />
  );
}

export function TableBody<T extends object>(props: TableBodyProps<T>) {
  return (
    <RACTableBody
      {...props}
      className="empty:text-center empty:text-epic-text-muted empty:py-10"
    />
  );
}
