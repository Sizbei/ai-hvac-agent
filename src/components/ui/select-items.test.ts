import { describe, it, expect } from "vitest"
import { createElement, Fragment } from "react"
import { collectSelectItems } from "./select-items"

function Item(props: { value: unknown; children?: React.ReactNode }) {
  return createElement("div", null, props.children)
}
function Content(props: { children?: React.ReactNode }) {
  return createElement("div", null, props.children)
}

describe("collectSelectItems", () => {
  it("collects value/label pairs through nested wrappers and fragments", () => {
    const tree = [
      createElement("span", { key: "t" }, "trigger"),
      createElement(
        Content,
        { key: "c" },
        createElement(Item, { value: "all" }, "All statuses"),
        createElement(
          Fragment,
          null,
          ["escalated", "chatting"].map((v) =>
            createElement(Item, { key: v, value: v }, v === "escalated" ? "Escalated" : "Chatting"),
          ),
        ),
      ),
    ]
    expect(collectSelectItems(tree, Item)).toEqual([
      { value: "all", label: "All statuses" },
      { value: "escalated", label: "Escalated" },
      { value: "chatting", label: "Chatting" },
    ])
  })

  it("keeps null values and ignores non-elements", () => {
    const tree = createElement(Content, null, null, false, "text", createElement(Item, { value: null }, "None"))
    expect(collectSelectItems(tree, Item)).toEqual([{ value: null, label: "None" }])
  })

  it("returns an empty list when there are no items", () => {
    expect(collectSelectItems(createElement(Content, null, "x"), Item)).toEqual([])
  })
})
