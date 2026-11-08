// Copyright (c) 2026 The Brave Authors. All rights reserved.
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this file,
// You can obtain one at https://mozilla.org/MPL/2.0/.

import * as React from 'react'
import { act, renderHook } from '@testing-library/react'
import getNTPBrowserAPI from '../../api/background'
import { EngineContextProvider, useEngineContext } from './EngineContext'

jest.mock('../../api/background', () => ({
  __esModule: true,
  default: jest.fn(),
}))
jest.mock('$web-common/loadTimeData', () => ({
  loadTimeData: { getString: () => 'search.brave.com' },
}))

describe('legacy NTP search source', () => {
  afterEach(() => localStorage.clear())

  it('loads native search engines, responds to default changes, and removes its listener', async () => {
    let listener = () => {}
    const google = {
      keyword: 'google',
      host: 'www.google.com',
      isDefault: true,
    }
    const bing = { keyword: 'bing', host: 'www.bing.com', isDefault: true }
    const api = {
      pageHandler: {
        getSearchEngines: jest
          .fn()
          .mockResolvedValue({ searchEngines: [google] }),
      },
      pageCallbackRouter: {
        onSearchEnginesChanged: {
          addListener: jest.fn((callback: () => void) => {
            listener = callback
            return 42
          }),
        },
        removeListener: jest.fn(),
      },
    }
    ;(getNTPBrowserAPI as jest.Mock).mockReturnValue(api)
    const wrapper = ({ children }: React.PropsWithChildren<{}>) => (
      <EngineContextProvider>{children}</EngineContextProvider>
    )
    const hook = renderHook(useEngineContext, { wrapper })
    await act(async () => {})
    expect(hook.result.current.searchEngines).toEqual([google])
    api.pageHandler.getSearchEngines.mockResolvedValue({
      searchEngines: [bing],
    })
    await act(async () => listener())
    expect(hook.result.current.searchEngines).toEqual([bing])
    hook.unmount()
    expect(api.pageCallbackRouter.removeListener).toHaveBeenCalledWith(42)
  })

  it('recovers corrupt widget config and normalizes historical Google host keys', async () => {
    const api = {
      pageHandler: {
        getSearchEngines: jest.fn().mockResolvedValue({ searchEngines: [] }),
      },
      pageCallbackRouter: {
        onSearchEnginesChanged: { addListener: jest.fn() },
        removeListener: jest.fn(),
      },
    }
    ;(getNTPBrowserAPI as jest.Mock).mockReturnValue(api)
    const wrapper = ({ children }: React.PropsWithChildren<{}>) => (
      <EngineContextProvider>{children}</EngineContextProvider>
    )
    localStorage.setItem('search-engines', 'broken')
    const corrupt = renderHook(useEngineContext, { wrapper })
    await act(async () => {})
    expect(corrupt.result.current.engineConfig['search.brave.com']).toBe(true)
    corrupt.unmount()
    localStorage.setItem('search-engines', JSON.stringify({ '': true }))
    const historical = renderHook(useEngineContext, { wrapper })
    await act(async () => {})
    expect(historical.result.current.engineConfig['www.google.com']).toBe(true)
  })
})
