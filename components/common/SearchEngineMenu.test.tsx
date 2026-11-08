// Copyright (c) 2026 The Brave Authors. All rights reserved.
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this file,
// You can obtain one at https://mozilla.org/MPL/2.0/.

import * as React from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { SearchEngineMenu } from './SearchEngineMenu'
import SearchPlaceholder from '../brave_new_tab_ui/components/search/SearchPlaceholder'

// Keep the real collapsed wrapper, with its dialog-opening click handler, while
// replacing legacy transport and search content with the shared picker.
jest.mock('../brave_new_tab_ui/hooks/usePref', () => ({
  useNewTabPref: () => [true, () => {}],
}))
jest.mock('../brave_new_tab_ui/api/background', () => ({
  __esModule: true,
  default: () => ({
    newTabMetrics: { reportNTPSearchDefaultEngine() {} },
  }),
}))
jest.mock('../brave_new_tab_ui/components/search/SearchContext', () => ({
  SearchContext: ({ children }: React.PropsWithChildren<{}>) => <>{children}</>,
  useSearchContext() {
    const [open, setOpen] = React.useState(false)
    return { open, setOpen }
  },
}))
jest.mock('../brave_new_tab_ui/components/search/SearchBox', () => ({
  __esModule: true,
  default: () => (
    <div>
      <span>Collapsed search box</span>
      <Picker
        onSelectEngine={() => {}}
        onCustomizeClick={() => {}}
      />
    </div>
  ),
}))
jest.mock('../brave_new_tab_ui/components/search/SearchDialog', () => ({
  __esModule: true,
  default: () => <div role='dialog'>Search dialog</div>,
}))

jest.mock('@brave/leo/react/floating', () => ({
  __esModule: true,
  default: ({ children }: React.PropsWithChildren<{}>) => <div>{children}</div>,
}))

const engines = ['Google', 'Yandex', 'Bing']

function Picker(props: {
  onSelectEngine: (engine: string) => void
  onCustomizeClick: () => void
}) {
  return (
    <SearchEngineMenu
      engines={engines}
      selectedEngine='Google'
      engineKey={(engine) => engine}
      engineName={(engine) => engine}
      renderIcon={() => <span>Icon</span>}
      label='Search engine for this tab: Google'
      description='Other choices apply only to this tab.'
      customizeLabel='Customize list'
      browserDefaultLabel='Change browser default'
      onSelectEngine={props.onSelectEngine}
      onCustomizeClick={props.onCustomizeClick}
    />
  )
}

function renderPicker() {
  const select = jest.fn()
  const customize = jest.fn()
  render(
    <Picker
      onSelectEngine={select}
      onCustomizeClick={customize}
    />,
  )
  return {
    select,
    customize,
    trigger: screen.getByRole('button', {
      name: 'Search engine for this tab: Google',
    }),
  }
}

describe('SearchEngineMenu accessibility shared by both NTPs', () => {
  it('names the adjacent legacy customization button for its menu purpose', async () => {
    const { container } = render(<SearchPlaceholder />)
    await act(async () => {})
    const button = container.querySelector('leo-button[slot="anchor-content"]')!
    const label = screen.getByText('customize: searchTitle')
    // jsdom's accessible-name computation does not traverse shadow slots.
    // Verify the real native button receives the localized text through its slot.
    const slot = button.shadowRoot!.querySelector('button slot')!
    expect((slot as HTMLSlotElement).assignedNodes()).toContain(label)
    expect(label).not.toHaveAttribute('hidden')
    expect(label.closest('[aria-hidden=true]')).toBeNull()
  })

  it('opens inside the collapsed legacy search wrapper without opening its dialog', () => {
    render(<SearchPlaceholder />)
    const trigger = screen.getByRole('button', {
      name: 'Search engine for this tab: Google',
    })
    fireEvent.click(trigger)
    expect(screen.getByRole('menu')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Yandex' }))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()

    fireEvent.click(screen.getByText('Collapsed search box'))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(trigger).not.toBeInTheDocument()
  })

  it('names the current provider and exposes expanded state and selection', () => {
    const { trigger } = renderPicker()
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    const menu = screen.getByRole('menu')
    expect(trigger.getAttribute('aria-controls')).toBe(menu.id)
    expect(menu).toHaveAccessibleDescription(
      'Other choices apply only to this tab.',
    )
    const google = screen.getByRole('menuitemradio', { name: 'Google' })
    expect(google).toHaveAttribute('aria-checked', 'true')
    expect(google).toHaveFocus()
    expect(
      screen.getByRole('menuitem', { name: 'Change browser default' }),
    ).toHaveAttribute('href', 'chrome://settings/searchEngines')
  })

  it('supports arrows, Home, End, Escape and focus return without submitting search', () => {
    const { trigger } = renderPicker()
    const globalKeyDown = jest.fn()
    document.addEventListener('keydown', globalKeyDown)
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    const google = screen.getByRole('menuitemradio', { name: 'Google' })
    fireEvent.keyDown(google, { key: 'ArrowDown' })
    expect(screen.getByRole('menuitemradio', { name: 'Yandex' })).toHaveFocus()
    fireEvent.keyDown(document.activeElement!, { key: 'End' })
    expect(
      screen.getByRole('menuitem', { name: 'Change browser default' }),
    ).toHaveFocus()
    fireEvent.keyDown(document.activeElement!, { key: 'Home' })
    expect(google).toHaveFocus()
    fireEvent.keyDown(google, { key: 'Escape' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
    expect(globalKeyDown).not.toHaveBeenCalled()
    document.removeEventListener('keydown', globalKeyDown)
  })

  it('selects one provider then returns focus, and closes on outside focus', () => {
    const { trigger, select } = renderPicker()
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Bing' }))
    expect(select).toHaveBeenCalledWith('Bing')
    expect(trigger).toHaveFocus()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    fireEvent.click(trigger)
    fireEvent.focusIn(document.body)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('preserves the selection caller focus policy after closing the menu', () => {
    const input = React.createRef<HTMLInputElement>()
    const select = jest.fn(() => input.current?.focus())
    render(
      <>
        <Picker
          onSelectEngine={select}
          onCustomizeClick={() => {}}
        />
        <input
          ref={input}
          aria-label='Search query'
        />
      </>,
    )
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Bing' }))
    expect(select).toHaveBeenCalledWith('Bing')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Search query' })).toHaveFocus()
  })

  it('returns to the trigger on Escape and allows native Tab departure', () => {
    const { trigger, select } = renderPicker()
    fireEvent.click(trigger)
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(trigger).toHaveFocus()
    expect(select).not.toHaveBeenCalled()

    fireEvent.click(trigger)
    const tab = new KeyboardEvent('keydown', {
      key: 'Tab',
      bubbles: true,
      cancelable: true,
    })
    fireEvent(document.activeElement!, tab)
    expect(tab.defaultPrevented).toBe(false)
    expect(trigger).toHaveFocus()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(select).not.toHaveBeenCalled()
  })
})
