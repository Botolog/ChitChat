import { BoxRenderable, TextRenderable, type CliRenderer } from "@opentui/core"
import type { ServiceConfig } from "../services/registry"
import type { AppContext } from "../app/context"

/** Persistent main-menu renderables. */
export interface MainMenuHandles {
  box: BoxRenderable
  items: { box: BoxRenderable; text: TextRenderable }[]
}

/** Build the main menu (real OpenTUI components, replacing the old string renderer). */
export function createMainMenu(
  renderer: CliRenderer,
  width: number,
  height: number,
  services: ServiceConfig[],
): MainMenuHandles {
  const menuBox = new BoxRenderable(renderer, {
    id: "menu-box",
    width,
    height,
    backgroundColor: "#0D1117",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
  })

  const menuTitle = new TextRenderable(renderer, {
    id: "menu-title",
    content: "═══════════════════════════════════════",
    fg: "#58A6FF",
  })

  const menuLogo = new TextRenderable(renderer, {
    id: "menu-logo",
    content: "💬 ChatClient",
    fg: "#FFFFFF",
  })

  const menuSubtitle = new TextRenderable(renderer, {
    id: "menu-subtitle",
    content: "Universal Messaging Client v1.0",
    fg: "#8B949E",
  })

  const menuSpacer = new TextRenderable(renderer, {
    id: "menu-spacer",
    content: " ",
    fg: "#8B949E",
  })

  const menuInstructions = new TextRenderable(renderer, {
    id: "menu-instructions",
    content: "Select a service:",
    fg: "#C9D1D9",
  })

  const items: { box: BoxRenderable; text: TextRenderable }[] = []

  for (let i = 0; i < services.length; i++) {
    const svc = services[i]
    const itemBox = new BoxRenderable(renderer, {
      id: `menu-item-box-${i}`,
      width: 30,
      height: 1,
      backgroundColor: i === 0 ? "#30363D" : "#0D1117",
      justifyContent: "center",
    })
    const itemText = new TextRenderable(renderer, {
      id: `menu-item-${i}`,
      content: `${svc.icon}  ${svc.name}`,
      fg: i === 0 ? "#FFFFFF" : "#8B949E",
    })
    itemBox.add(itemText)
    items.push({ box: itemBox, text: itemText })
  }

  const menuFooter = new TextRenderable(renderer, {
    id: "menu-footer",
    content: "↑↓ Navigate │ Enter Select │ S Settings │ Q Quit",
    fg: "#6E7681",
  })

  menuBox.add(menuTitle)
  menuBox.add(menuLogo)
  menuBox.add(menuSubtitle)
  menuBox.add(menuSpacer)
  menuBox.add(menuInstructions)
  for (const item of items) {
    menuBox.add(item.box)
  }
  menuBox.add(menuSpacer)
  menuBox.add(menuFooter)

  return { box: menuBox, items }
}

/** Repaint the selected/unselected item styling from `state.menuSelectedIndex`. */
export function updateMenuSelection(ctx: AppContext): void {
  const items = ctx.handles.menu.items
  for (let i = 0; i < items.length; i++) {
    const isSelected = i === ctx.state.menuSelectedIndex
    items[i].box.backgroundColor = isSelected ? "#30363D" : "#0D1117"
    items[i].text.fg = isSelected ? "#FFFFFF" : "#8B949E"
  }
}
