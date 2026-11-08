// Copyright (c) 2026 The Brave Authors. All rights reserved.
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this file,
// You can obtain one at https://mozilla.org/MPL/2.0/.

import * as React from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { handleOpenURLClick } from '$web-common/SecureLink'
import type {
  AutocompleteMatch,
  AutocompleteResult,
} from 'chrome://resources/mojo/components/omnibox/browser/searchbox.mojom-webui.js'
import getNTPBrowserAPI, { SearchEngineInfo } from '../../api/background'
import { useEngineContext } from './EngineContext'
import {
  omniboxController,
  search,
  SearchContext,
  useSearchContext,
} from './SearchContext'
import SearchBox from './SearchBox'
import SearchResults from './SearchResults'
import SearchPlaceholder from './SearchPlaceholder'

jest.mock('../../api/background', () => ({
  __esModule: true,
  default: jest.fn(),
}))
jest.mock('./EngineContext', () => ({ useEngineContext: jest.fn() }))
jest.mock('../../hooks/usePref', () => ({
  useNewTabPref: () => [true, () => {}],
}))
jest.mock('$web-common/loadTimeData', () => ({
  loadTimeData: { getString: () => 'search.brave.com' },
}))
jest.mock('./SearchEngineIcon', () => ({
  MediumSearchEngineIcon: () => <span>Engine icon</span>,
}))
jest.mock('./MaybePromptEnableSuggestions', () => ({
  __esModule: true,
  default: () => null,
}))
jest.mock('./SearchResult', () => ({
  __esModule: true,
  default: ({
    match,
    onClick,
    selected,
  }: {
    match: AutocompleteMatch
    onClick: React.MouseEventHandler<HTMLAnchorElement>
    selected: boolean
  }) => (
    <a
      href={match.destinationUrl}
      onClick={onClick}
      aria-selected={selected}
    >
      {match.contents}
    </a>
  ),
}))
jest.mock('@brave/leo/react/icon', () => ({
  __esModule: true,
  default: () => null,
}))
jest.mock('@brave/leo/react/floating', () => ({
  __esModule: true,
  default: ({ children }: React.PropsWithChildren<{}>) => <div>{children}</div>,
}))
jest.mock('$web-common/SecureLink', () => ({
  ...jest.requireActual('$web-common/SecureLink'),
  handleOpenURLClick: jest.fn(),
}))
jest.mock(
  'chrome://resources/mojo/components/omnibox/browser/searchbox.mojom-webui.js',
  () => ({
    // Mojo transport is unavailable in Jest; the enum values are not under test.
    InputMethod: {},
    PageHandlerRemote: class {
      $ = { bindNewPipeAndPassReceiver() {} }
      queryAutocomplete = jest.fn()
      stopAutocomplete = jest.fn()
      openAutocompleteMatch = jest.fn()
    },
    PageReceiver: class {
      $ = { bindNewPipeAndPassRemote() {} }
    },
    PageHandlerFactory: {
      getRemote: () => ({ createPageHandler() {} }),
    },
  }),
)
jest.mock(
  'chrome://resources/mojo/components/omnibox/browser/fusebox_action.mojom-webui.js',
  () => ({
    SuggestInventory: {},
  }),
)

const alpha = {
  name: 'Alpha',
  keyword: 'alpha',
  host: 'alpha.test',
  isDefault: true,
  prepopulateId: 0,
  faviconUrl: { url: '' },
} as SearchEngineInfo
const beta = { ...alpha, name: 'Beta', keyword: 'beta', host: 'beta.test' }
let engines = [alpha]

function QueryProbe() {
  return (
    <output data-testid='committed-query'>{useSearchContext().query}</output>
  )
}

function SearchWidget() {
  return (
    <SearchContext>
      <SearchBox />
      <SearchResults />
      <QueryProbe />
    </SearchContext>
  )
}

async function renderSearch() {
  const view = render(<SearchWidget />)
  await act(async () => {})
  const input = view.container
    .querySelector('leo-input')
    ?.shadowRoot?.querySelector('input')
  expect(input).toBeInstanceOf(HTMLInputElement)
  return { ...view, input: input as HTMLInputElement }
}

function type(input: HTMLInputElement, query: string) {
  input.value = query
  input.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
}

function expectInputFocus(input: HTMLInputElement) {
  const root = input.getRootNode() as ShadowRoot
  expect(root).toBeInstanceOf(ShadowRoot)
  expect(document.activeElement).toBe(root.host)
  expect(root.activeElement).toBe(input)
}

function enter(input: HTMLInputElement, modifiers: KeyboardEventInit = {}) {
  input.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      composed: true,
      cancelable: true,
      ...modifiers,
    }),
  )
}

function deliverResult(matches: AutocompleteMatch[]) {
  const calls = (omniboxController.queryAutocomplete as jest.Mock).mock.calls
  const [queryId] = calls[calls.length - 1]
  act(() =>
    search.autocompleteResultChanged({
      queryId,
      sequenceId: 42,
      matches,
    } as AutocompleteResult),
  )
  return queryId as number
}

const suggestion = {
  destinationUrl: 'https://alpha.test/suggestion',
  contents: 'Suggested search',
  description: '',
  allowedToBeDefaultMatch: true,
  type: 'search-suggest',
} as AutocompleteMatch

describe('legacy search submission with the real Leo input', () => {
  let searchWhatYouTyped: jest.Mock

  beforeEach(() => {
    engines = [alpha]
    searchWhatYouTyped = jest.fn()
    ;(getNTPBrowserAPI as jest.Mock).mockReturnValue({
      pageHandler: { searchWhatYouTyped },
      newTabMetrics: {
        reportNTPSearchDefaultEngine: jest.fn(),
        reportNTPSearchUsage: jest.fn(),
      },
    })
    ;(useEngineContext as jest.Mock).mockImplementation(() => ({
      searchEngines: engines,
      engineConfig: {},
    }))
    search.clearResults()
  })

  it('places the provider before the query in separate sequential focus scopes', async () => {
    const { container, input } = await renderSearch()
    const host = container.querySelector('leo-input')!
    const trigger = screen.getByRole('button', {
      name: 'searchEnginePickerLabel: Alpha',
    })
    expect(host).toHaveAttribute('tabindex', '0')
    expect(host.contains(trigger)).toBe(false)
    expect(
      trigger.compareDocumentPosition(host) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(host.querySelector('[slot="left-icon"]')).toHaveAttribute(
      'aria-hidden',
      'true',
    )
    expect(input).toBeInstanceOf(HTMLInputElement)
  })

  it('submits the visible pasted query before React commits the input update', async () => {
    const { input } = await renderSearch()
    act(() => {
      type(input, 'fast paste token')
      expect(input.value).toBe('fast paste token')
      expect(screen.getByTestId('committed-query').textContent).toBe('')
      enter(input, { ctrlKey: true, shiftKey: true })
    })
    expect(screen.getByTestId('committed-query')).toHaveTextContent(
      'fast paste token',
    )
    expect(searchWhatYouTyped).toHaveBeenCalledWith(
      'alpha',
      'fast paste token',
      false,
      true,
      false,
      true,
    )
    expect(omniboxController.openAutocompleteMatch).not.toHaveBeenCalled()
  })

  it('does not open an older default suggestion after the query changes', async () => {
    const { input } = await renderSearch()
    act(() => type(input, 'old'))
    deliverResult([suggestion])
    expect(screen.getByText('Suggested search')).toHaveAttribute(
      'aria-selected',
      'true',
    )
    act(() => {
      type(input, 'new token')
      enter(input)
    })
    expect(searchWhatYouTyped).toHaveBeenCalledWith(
      'alpha',
      'new token',
      false,
      false,
      false,
      false,
    )
    expect(omniboxController.openAutocompleteMatch).not.toHaveBeenCalled()
  })

  it('does not retain a previous autocomplete reply when an edit commits', async () => {
    const { input } = await renderSearch()
    act(() => type(input, 'old'))
    const queryId = deliverResult([suggestion])
    act(() => {
      type(input, 'new token')
      search.autocompleteResultChanged({
        queryId,
        sequenceId: 43,
        matches: [suggestion],
      } as AutocompleteResult)
    })
    expect(screen.queryByText('Suggested search')).not.toBeInTheDocument()
    act(() => enter(input))
    expect(searchWhatYouTyped).toHaveBeenCalledWith(
      'alpha',
      'new token',
      false,
      false,
      false,
      false,
    )
    expect(omniboxController.openAutocompleteMatch).not.toHaveBeenCalled()
    act(() =>
      search.autocompleteResultChanged({
        queryId,
        sequenceId: 44,
        matches: [suggestion],
      } as AutocompleteResult),
    )
    expect(screen.queryByText('Suggested search')).not.toBeInTheDocument()
  })

  it('uses the current native default and clears the previous provider suggestions', async () => {
    const { input, rerender } = await renderSearch()
    act(() => type(input, 'current query'))
    deliverResult([suggestion])
    engines = [beta]
    rerender(<SearchWidget />)
    expect(
      screen.getByRole('button', { name: 'searchEnginePickerLabel: Beta' }),
    ).toBeInTheDocument()
    expect(screen.queryByText('Suggested search')).not.toBeInTheDocument()
    act(() => enter(input, { altKey: true, metaKey: true }))
    expect(searchWhatYouTyped).toHaveBeenCalledWith(
      'beta',
      'current query',
      true,
      false,
      true,
      false,
    )
    expect(omniboxController.openAutocompleteMatch).not.toHaveBeenCalled()
  })

  it('clears suggestions after a live provider edit even when its keyword is unchanged', async () => {
    const { input, rerender } = await renderSearch()
    act(() => type(input, 'current query'))
    const queryId = deliverResult([suggestion])
    engines = [{ ...alpha, name: 'Alpha edited', host: 'edited.test' }]
    rerender(<SearchWidget />)
    expect(
      screen.getByRole('button', {
        name: 'searchEnginePickerLabel: Alpha edited',
      }),
    ).toBeInTheDocument()
    act(() =>
      search.autocompleteResultChanged({
        queryId,
        sequenceId: 43,
        matches: [suggestion],
      } as AutocompleteResult),
    )
    expect(screen.queryByText('Suggested search')).not.toBeInTheDocument()
    act(() => enter(input))
    expect(searchWhatYouTyped).toHaveBeenCalledWith(
      'alpha',
      'current query',
      false,
      false,
      false,
      false,
    )
    expect(omniboxController.openAutocompleteMatch).not.toHaveBeenCalled()
  })

  it('preserves explicit suggestion selection and keyboard modifiers', async () => {
    const { input } = await renderSearch()
    act(() => type(input, 'query'))
    const second = {
      ...suggestion,
      contents: 'Second suggestion',
      destinationUrl: 'https://alpha.test/second',
    }
    deliverResult([suggestion, second])
    fireEvent.keyDown(input, { key: 'ArrowDown', composed: true })
    expect(screen.getByText('Second suggestion')).toHaveAttribute(
      'aria-selected',
      'true',
    )
    act(() => enter(input, { ctrlKey: true, shiftKey: true }))
    expect(omniboxController.openAutocompleteMatch).toHaveBeenCalledWith(
      42,
      1,
      second.destinationUrl,
      true,
      0,
      {
        altKey: false,
        ctrlKey: true,
        metaKey: false,
        shiftKey: true,
      },
      true,
    )
    expect(searchWhatYouTyped).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Suggested search'), { metaKey: true })
    expect(omniboxController.openAutocompleteMatch).toHaveBeenLastCalledWith(
      42,
      0,
      suggestion.destinationUrl,
      true,
      0,
      {
        altKey: false,
        ctrlKey: false,
        metaKey: true,
        shiftKey: false,
      },
      false,
    )
  })

  it('preserves URL navigation when a URL is pasted and submitted before commit', async () => {
    const { input } = await renderSearch()
    act(() => {
      type(input, 'example.test/path')
      enter(input, { ctrlKey: true })
    })
    expect(handleOpenURLClick).toHaveBeenCalledWith(
      'https://example.test/path',
      expect.objectContaining({ ctrlKey: true }),
    )
    expect(searchWhatYouTyped).not.toHaveBeenCalled()
    expect(omniboxController.openAutocompleteMatch).not.toHaveBeenCalled()
  })

  it('does not submit when picker buttons handle Enter or Space', async () => {
    engines = [alpha, { ...beta, isDefault: false }]
    ;(useEngineContext as jest.Mock).mockImplementation(() => ({
      searchEngines: engines,
      engineConfig: { 'beta.test': true },
    }))
    const { input } = await renderSearch()
    act(() => type(input, 'keep this query'))
    const trigger = screen.getByRole('button', {
      name: 'searchEnginePickerLabel: Alpha',
    })
    for (const key of ['Enter', ' ']) {
      fireEvent.keyDown(trigger, { key })
      fireEvent.keyUp(trigger, { key })
    }
    fireEvent.click(trigger)
    const item = screen.getByRole('menuitemradio', { name: 'Beta' })
    for (const key of ['Enter', ' ']) {
      fireEvent.keyDown(item, { key })
      fireEvent.keyUp(item, { key })
    }
    fireEvent.click(item)
    expectInputFocus(input)
    expect(searchWhatYouTyped).not.toHaveBeenCalled()
    expect(omniboxController.openAutocompleteMatch).not.toHaveBeenCalled()
    expect(input.value).toBe('keep this query')
  })

  it('returns collapsed selection to the real query input and opens normal typing', async () => {
    engines = [alpha, { ...beta, isDefault: false }]
    ;(useEngineContext as jest.Mock).mockImplementation(() => ({
      searchEngines: engines,
      engineConfig: { 'beta.test': true },
    }))
    const showModalDescriptor = Object.getOwnPropertyDescriptor(
      HTMLDialogElement.prototype,
      'showModal',
    )
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.open = true
      },
    })
    const view = render(<SearchPlaceholder />)
    try {
      await act(async () => {})
      const input = view.container
        .querySelector('leo-input')!
        .shadowRoot!.querySelector('input')!
      const trigger = screen.getByRole('button', {
        name: 'searchEnginePickerLabel: Alpha',
      })
      fireEvent.click(trigger)
      fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
      expect(trigger).toHaveFocus()
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      fireEvent.click(trigger)
      fireEvent.click(screen.getByRole('menuitemradio', { name: 'Beta' }))
      expectInputFocus(input)
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(searchWhatYouTyped).not.toHaveBeenCalled()

      act(() => type(input, 'continue typing'))
      await act(async () => {})
      const dialog = screen.getByRole('dialog')
      const dialogInput = dialog
        .querySelector('leo-input')!
        .shadowRoot!.querySelector('input')!
      expect(dialogInput.value).toBe('continue typing')
      expect(
        screen.getByRole('button', { name: 'searchEnginePickerLabel: Beta' }),
      ).toBeInTheDocument()
      act(() => enter(dialogInput))
      expect(searchWhatYouTyped).toHaveBeenCalledWith(
        'beta',
        'continue typing',
        false,
        false,
        false,
        false,
      )
    } finally {
      view.unmount()
      if (showModalDescriptor) {
        Object.defineProperty(
          HTMLDialogElement.prototype,
          'showModal',
          showModalDescriptor,
        )
      } else {
        delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>)
          .showModal
      }
    }
  })

  it('respects a previously prevented Enter', async () => {
    const { input } = await renderSearch()
    act(() => type(input, 'query'))
    input.addEventListener('keydown', (event) => event.preventDefault())
    act(() => enter(input))
    expect(searchWhatYouTyped).not.toHaveBeenCalled()
    expect(omniboxController.openAutocompleteMatch).not.toHaveBeenCalled()
  })
})
