import {
  Button,
  Checkbox,
  Dialog,
  DialogTrigger,
  Heading,
  ListBox,
  ListBoxItem,
  Menu,
  MenuItem,
  MenuTrigger,
  Modal,
  Popover,
  Select,
  SelectValue,
  Switch,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  Tooltip,
  TooltipTrigger,
} from "react-aria-components"
import { createRoot } from "react-dom/client"

function App() {
  return (
    <div>
      <DialogTrigger>
        <Button>Abrir</Button>
        <Modal>
          <Dialog>
            <Heading slot="title">Hola</Heading>
            <Button slot="close">x</Button>
          </Dialog>
        </Modal>
      </DialogTrigger>
      <Select defaultSelectedKey="a" aria-label="sel">
        <Button>
          <SelectValue />
        </Button>
        <Popover>
          <ListBox>
            <ListBoxItem id="a">A</ListBoxItem>
            <ListBoxItem id="b">B</ListBoxItem>
            <ListBoxItem id="c">C</ListBoxItem>
          </ListBox>
        </Popover>
      </Select>
      <Checkbox>c</Checkbox>
      <Switch>s</Switch>
      <DialogTrigger>
        <Button>Popover</Button>
        <Popover>
          <Dialog>contenido</Dialog>
        </Popover>
      </DialogTrigger>
      <MenuTrigger>
        <Button>Menú</Button>
        <Popover>
          <Menu>
            <MenuItem>Uno</MenuItem>
          </Menu>
        </Popover>
      </MenuTrigger>
      <Tabs>
        <TabList aria-label="t">
          <Tab id="a">A</Tab>
          <Tab id="b">B</Tab>
        </TabList>
        <TabPanel id="a">pa</TabPanel>
        <TabPanel id="b">pb</TabPanel>
      </Tabs>
      <TooltipTrigger>
        <Button>?</Button>
        <Tooltip>tooltip</Tooltip>
      </TooltipTrigger>
    </div>
  )
}
export const app = <App />
if (typeof document !== "undefined")
  createRoot(document.getElementById("root") as HTMLElement).render(app)
