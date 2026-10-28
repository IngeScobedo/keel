import { Checkbox } from "@base-ui/react/checkbox"
import { Dialog } from "@base-ui/react/dialog"
import { Menu } from "@base-ui/react/menu"
import { Popover } from "@base-ui/react/popover"
import { Select } from "@base-ui/react/select"
import { Switch } from "@base-ui/react/switch"
import { Tabs } from "@base-ui/react/tabs"
import { Tooltip } from "@base-ui/react/tooltip"
import { createRoot } from "react-dom/client"

const items = [
  { value: "a", label: "A" },
  { value: "b", label: "B" },
  { value: "c", label: "C" },
]
function App() {
  return (
    <Tooltip.Provider>
      <Dialog.Root>
        <Dialog.Trigger>Abrir</Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Backdrop />
          <Dialog.Popup>
            <Dialog.Title>Hola</Dialog.Title>
            <Dialog.Close>x</Dialog.Close>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
      <Select.Root items={items} defaultValue="a">
        <Select.Trigger>
          <Select.Value />
          <Select.Icon />
        </Select.Trigger>
        <Select.Portal>
          <Select.Positioner>
            <Select.Popup>
              {items.map((i) => (
                <Select.Item key={i.value} value={i.value}>
                  <Select.ItemText>{i.label}</Select.ItemText>
                </Select.Item>
              ))}
            </Select.Popup>
          </Select.Positioner>
        </Select.Portal>
      </Select.Root>
      <Checkbox.Root>
        <Checkbox.Indicator />
      </Checkbox.Root>
      <Switch.Root>
        <Switch.Thumb />
      </Switch.Root>
      <Popover.Root>
        <Popover.Trigger>Popover</Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner>
            <Popover.Popup>contenido</Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
      <Menu.Root>
        <Menu.Trigger>Menú</Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner>
            <Menu.Popup>
              <Menu.Item>Uno</Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      <Tabs.Root defaultValue="a">
        <Tabs.List>
          <Tabs.Tab value="a">A</Tabs.Tab>
          <Tabs.Tab value="b">B</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="a">pa</Tabs.Panel>
        <Tabs.Panel value="b">pb</Tabs.Panel>
      </Tabs.Root>
      <Tooltip.Root>
        <Tooltip.Trigger>?</Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Positioner>
            <Tooltip.Popup>tooltip</Tooltip.Popup>
          </Tooltip.Positioner>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  )
}
export const app = <App />
if (typeof document !== "undefined")
  createRoot(document.getElementById("root") as HTMLElement).render(app)
