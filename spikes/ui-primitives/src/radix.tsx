import { Checkbox, Dialog, DropdownMenu, Popover, Select, Switch, Tabs, Tooltip } from "radix-ui"
import { createRoot } from "react-dom/client"

function App() {
  return (
    <Tooltip.Provider>
      <Dialog.Root>
        <Dialog.Trigger>Abrir</Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Overlay />
          <Dialog.Content>
            <Dialog.Title>Hola</Dialog.Title>
            <Dialog.Close>x</Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <Select.Root defaultValue="a">
        <Select.Trigger>
          <Select.Value />
          <Select.Icon />
        </Select.Trigger>
        <Select.Portal>
          <Select.Content>
            <Select.Viewport>
              {["a", "b", "c"].map((v) => (
                <Select.Item key={v} value={v}>
                  <Select.ItemText>{v.toUpperCase()}</Select.ItemText>
                </Select.Item>
              ))}
            </Select.Viewport>
          </Select.Content>
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
          <Popover.Content>contenido</Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger>Menú</DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content>
            <DropdownMenu.Item>Uno</DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <Tabs.Root defaultValue="a">
        <Tabs.List>
          <Tabs.Trigger value="a">A</Tabs.Trigger>
          <Tabs.Trigger value="b">B</Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="a">pa</Tabs.Content>
        <Tabs.Content value="b">pb</Tabs.Content>
      </Tabs.Root>
      <Tooltip.Root>
        <Tooltip.Trigger>?</Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content>tooltip</Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  )
}
export const app = <App />
if (typeof document !== "undefined")
  createRoot(document.getElementById("root") as HTMLElement).render(app)
