---
name: ui-design
description: Iterate on the UI design of an Electric SQL app. Reviews current components against Radix UI Themes best practices, suggests improvements, and applies changes interactively. Use after the app is generated to polish the UI.
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, AskUserQuestion
---

# UI Design — Interactive Iteration

You are helping the user improve the UI of their Electric SQL app. This skill loads the design system and component patterns, then enters an interactive loop to refine the interface.

## Step 1: Audit Current UI

Read all route and component files to understand the current UI:

```
Glob pattern: src/routes/**/*.tsx
Glob pattern: src/components/**/*.tsx
```

For each file, check against the rules below and note violations.

## Step 2: Present Findings

Show the user a brief summary:
- What looks good (patterns already followed)
- What needs improvement (specific violations with file:line references)
- Quick wins (changes that would have the biggest visual impact)

## Step 3: Interactive Loop

Ask the user what they want to focus on. Suggestions:
- Fix all anti-pattern violations
- Improve a specific page/component
- Change the overall aesthetic direction
- Add missing UI patterns (empty states, loading, delete confirmations)

Apply changes, then ask for the next iteration. Repeat until the user is satisfied.

---

# Design System Reference

## Default Electric Theme

The `__root.tsx` `<Theme>` wrapper MUST use the Electric brand defaults:

```tsx
<Theme accentColor="violet" grayColor="mauve" radius="medium" panelBackground="translucent">
```

- `accentColor="violet"` — Electric brand purple
- `grayColor="mauve"` — gray with violet undertone, cohesive with accent
- `radius="medium"` — balanced, professional corners
- `panelBackground="translucent"` — subtle depth on surfaces

If `__root.tsx` has a different `accentColor` (e.g. `"blue"`), change it to the values above.

CSS custom properties in `styles.css` for Electric brand colors not covered by Radix tokens:

```css
:root {
  --electric-brand: #d0bcff;
  --electric-teal: #00d2a0;
}
```

---

## Design Thinking

### Design Direction

Before making changes, commit to a coherent aesthetic:
- Understand the app's purpose and audience
- The Electric theme provides a polished violet-on-dark foundation — lean into it
- Pick a direction that complements the Electric brand: clean professional, modern minimal, or dark moody work best
- Every detail must serve that direction — fonts, colors, spacing, component variants

### Typography Rules

- NEVER add spacing props on text elements — use `gap` on parent Flex (capsize rule)
- Work the full typographic range: size, weight, color to establish hierarchy
- Heading `size="7"` or `size="8"` for page titles, `size="5"` or `size="6"` for section titles, `size="3"` or `size="4"` for labels
- Use `color="gray"` for secondary text, `weight="medium"` for emphasis

### Color with Conviction

- NEVER: timid evenly-distributed palettes, gray-on-gray everything, random accent colors
- INSTEAD: use the Theme's `accentColor` intentionally — primary actions get accent, secondary get `color="gray"`, destructive get `color="red"`
- Use Badge `variant="soft"` with semantic colors: green=success, orange=warning, red=error, blue=info
- Dark backgrounds via `Card variant="surface"` — do not manually set background colors

### Spatial Composition

- NEVER: everything centered, uniform padding, flat visual hierarchy
- INSTEAD: use `justify="between"` for page headers (title left, actions right), consistent gap scale (2=tight, 3=default, 4=comfortable, 6=section), visual weight through Card/Table surfaces

### Anti-patterns (NEVER do)

- Raw HTML elements (`<button>`, `<input>`, `<table>`) — always use Radix components
- Inline `style={{}}` for spacing/colors — use Radix props (p, m, gap, color, variant)
- Empty pages with just text — always provide empty states with icon + message + action
- Giant forms without structure — group related fields, use Dialog for create/edit
- Tables without visual anchoring — use `variant="surface"` or Card wrappers

### Import Rules

- Use `@radix-ui/themes` for all components (NOT `@radix-ui/react-*`)
- Use `lucide-react` for icons (NOT `@radix-ui/react-icons`)
- NEVER add spacing props directly on Text/Heading — use `gap` on parent Flex

---

## Component Patterns

Copy-paste-ready patterns using `@radix-ui/themes` and `lucide-react`.

### Pattern 1: Page Layout

Standard page shell with header row.

```tsx
import { Container, Flex, Heading, Button } from "@radix-ui/themes"
import { Plus } from "lucide-react"

<Container size="3" py="6">
  <Flex direction="column" gap="5">
    <Flex justify="between" align="center">
      <Heading size="6">Items</Heading>
      <Button><Plus size={16} /> Add Item</Button>
    </Flex>
    {/* data table or card list */}
  </Flex>
</Container>
```

### Pattern 2: Data Table

Table with status badges and row-level actions.

```tsx
import { Table, Text, Badge, Flex, IconButton } from "@radix-ui/themes"
import { Pencil, Trash2 } from "lucide-react"

<Table.Root variant="surface">
  <Table.Header>
    <Table.Row>
      <Table.ColumnHeaderCell>Name</Table.ColumnHeaderCell>
      <Table.ColumnHeaderCell>Status</Table.ColumnHeaderCell>
      <Table.ColumnHeaderCell width="80px" />
    </Table.Row>
  </Table.Header>
  <Table.Body>
    {items.map(item => (
      <Table.Row key={item.id}>
        <Table.Cell><Text weight="medium">{item.name}</Text></Table.Cell>
        <Table.Cell>
          <Badge color={item.done ? "green" : "orange"} variant="soft">
            {item.done ? "Done" : "Pending"}
          </Badge>
        </Table.Cell>
        <Table.Cell>
          <Flex gap="2">
            <IconButton size="1" variant="ghost" onClick={...}>
              <Pencil size={14} />
            </IconButton>
            <IconButton size="1" variant="ghost" color="red" onClick={...}>
              <Trash2 size={14} />
            </IconButton>
          </Flex>
        </Table.Cell>
      </Table.Row>
    ))}
  </Table.Body>
</Table.Root>
```

### Pattern 3: Card List

For rich content or mobile-friendly layouts.

```tsx
import { Card, Flex, Text, Badge } from "@radix-ui/themes"

<Flex direction="column" gap="3">
  {items.map(item => (
    <Card key={item.id}>
      <Flex justify="between" align="center">
        <Flex direction="column" gap="1">
          <Text weight="medium">{item.title}</Text>
          <Text size="2" color="gray">{item.description}</Text>
        </Flex>
        <Badge variant="soft" color="blue">{item.category}</Badge>
      </Flex>
    </Card>
  ))}
</Flex>
```

### Pattern 4: Create/Edit Dialog

```tsx
import { Dialog, Flex, Text, TextField, Select, Button } from "@radix-ui/themes"

<Dialog.Root open={open} onOpenChange={setOpen}>
  <Dialog.Trigger><Button>Add Item</Button></Dialog.Trigger>
  <Dialog.Content maxWidth="450px">
    <Dialog.Title>New Item</Dialog.Title>
    <Flex direction="column" gap="4" mt="4">
      <label>
        <Text size="2" weight="medium" as="div" mb="1">Name</Text>
        <TextField.Root placeholder="Enter name" value={name}
          onChange={e => setName(e.target.value)} />
      </label>
      <label>
        <Text size="2" weight="medium" as="div" mb="1">Category</Text>
        <Select.Root value={category} onValueChange={setCategory}>
          <Select.Trigger placeholder="Select category" />
          <Select.Content>
            <Select.Item value="a">Category A</Select.Item>
            <Select.Item value="b">Category B</Select.Item>
          </Select.Content>
        </Select.Root>
      </label>
      <Flex gap="3" justify="end" mt="2">
        <Dialog.Close>
          <Button variant="soft" color="gray">Cancel</Button>
        </Dialog.Close>
        <Button onClick={handleSubmit}>Save</Button>
      </Flex>
    </Flex>
  </Dialog.Content>
</Dialog.Root>
```

### Pattern 5: Empty State

```tsx
import { Flex, Text, Button } from "@radix-ui/themes"
import { Inbox } from "lucide-react"

<Flex direction="column" align="center" gap="3" py="9">
  <Inbox size={48} strokeWidth={1} color="var(--gray-8)" />
  <Text size="4" color="gray">No items yet</Text>
  <Button variant="soft" onClick={...}>Create your first item</Button>
</Flex>
```

### Pattern 6: Delete Confirmation

```tsx
import { AlertDialog, Flex, Button } from "@radix-ui/themes"

<AlertDialog.Root open={!!deleteTarget} onOpenChange={...}>
  <AlertDialog.Content maxWidth="400px">
    <AlertDialog.Title>Delete Item</AlertDialog.Title>
    <AlertDialog.Description size="2">
      This action cannot be undone.
    </AlertDialog.Description>
    <Flex gap="3" justify="end" mt="4">
      <AlertDialog.Cancel>
        <Button variant="soft" color="gray">Cancel</Button>
      </AlertDialog.Cancel>
      <AlertDialog.Action>
        <Button color="red" onClick={handleDelete}>Delete</Button>
      </AlertDialog.Action>
    </Flex>
  </AlertDialog.Content>
</AlertDialog.Root>
```

### Pattern 7: Loading State

```tsx
import { Flex, Spinner } from "@radix-ui/themes"

<Flex align="center" justify="center" py="9">
  <Spinner size="3" />
</Flex>
```

### Pattern 8: Multi-section Navigation

```tsx
import { TabNav } from "@radix-ui/themes"

<TabNav.Root>
  <TabNav.Link href="/tasks" active={pathname === "/tasks"}>Tasks</TabNav.Link>
  <TabNav.Link href="/settings" active={pathname === "/settings"}>Settings</TabNav.Link>
</TabNav.Root>
```

### Pattern 9: Responsive Grid Layout

```tsx
import { Grid, Card } from "@radix-ui/themes"

<Grid columns={{ initial: "1", sm: "2", md: "3" }} gap="4">
  {items.map(item => (
    <Card key={item.id}>...</Card>
  ))}
</Grid>
```

---

## Component Quick Reference

| Need | Use | Key props |
|------|-----|-----------|
| Data list (many cols) | `Table.Root` | `variant="surface"` |
| Data list (rich content) | Card list in Flex | `direction="column" gap="3"` |
| Grid of cards | `Grid` | `columns={{ initial: "1", sm: "2", md: "3" }}` |
| Create/Edit forms | `Dialog` | `maxWidth="450px"` |
| Destructive confirm | `AlertDialog` | `maxWidth="400px"` |
| Status indicator | `Badge` | `variant="soft" color="green/orange/red"` |
| Primary action | `Button` | default (solid variant) |
| Secondary action | `Button` | `variant="soft" color="gray"` |
| Row-level action | `IconButton` | `size="1" variant="ghost"` |
| Page wrapper | `Container` | `size="2"` or `size="3"` with `py="6"` |
| Vertical stack | `Flex` | `direction="column" gap="3-5"` |
| Page header row | `Flex` | `justify="between" align="center"` |
| Multi-section nav | `TabNav` | with `active` prop on links |
| Loading | `Spinner` | `size="3"` centered |
| Empty state | Flex + icon + Text + Button | centered with `py="9"` |
