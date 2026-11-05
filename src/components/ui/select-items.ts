import { Children, isValidElement, type ElementType, type ReactNode } from "react"

/** One `{ value, label }` entry Base UI's `Select.Root items` understands. */
export interface CollectedSelectItem {
  readonly value: unknown
  readonly label: ReactNode
}

/**
 * Walk a Select's children and collect every `itemType` element as
 * `{ value, label }` (label = the item's children). Base UI's `Select.Value`
 * renders the RAW value unless the root has an `items` map, so the shared
 * `Select` feeds it this list — every caller then shows the option's label
 * ("All statuses", "Heat pump") instead of `all` / `heat_pump`.
 *
 * Recurses through any element's `children` (SelectContent, SelectGroup,
 * fragments). Items rendered inside a custom component are not visible here;
 * those callers keep the old behaviour unless they pass `items` themselves.
 */
export function collectSelectItems(
  children: ReactNode,
  itemType: ElementType,
): CollectedSelectItem[] {
  const found: CollectedSelectItem[] = []
  const visit = (node: ReactNode): void => {
    Children.forEach(node, (child) => {
      if (!isValidElement(child)) return
      const props = child.props as { value?: unknown; children?: ReactNode }
      if (child.type === itemType && "value" in props) {
        found.push({ value: props.value, label: props.children })
        return
      }
      if (props.children !== undefined) visit(props.children)
    })
  }
  visit(children)
  return found
}
