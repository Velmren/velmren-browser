// Copyright (c) 2024 The Brave Authors. All rights reserved.
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this file,
// You can obtain one at https://mozilla.org/MPL/2.0/.
import * as React from 'react'
import getNTPBrowserAPI, { SearchEngineInfo } from '../../api/background'
import { ENABLED_SEARCH_ENGINES_KEY, defaultSearchHost } from './config'

interface Engine {
  searchEngines: SearchEngineInfo[]
  engineConfig: Record<string, boolean>
  setEngineConfig: (engine: string, enabled: boolean) => void
}

const EngineContext = React.createContext<Engine>({
  searchEngines: [],
  engineConfig: {},
  setEngineConfig() {},
})

function searchEngineConfig(): Record<string, boolean> {
  try {
    const value = JSON.parse(
      localStorage.getItem(ENABLED_SEARCH_ENGINES_KEY) ?? 'null',
    )
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      // Normalize Google's old unresolved template host.
      if (value[''] || value['google.com']) value['www.google.com'] = true
      return value
    }
  } catch {}
  return { [defaultSearchHost]: true }
}

export function EngineContextProvider(props: React.PropsWithChildren<{}>) {
  const [searchEngines, setSearchEngines] = React.useState<SearchEngineInfo[]>(
    [],
  )
  const [config, setConfig] = React.useState(searchEngineConfig)

  React.useEffect(() => {
    const api = getNTPBrowserAPI()
    let active = true
    let request = 0
    const update = async () => {
      const sequence = ++request
      const { searchEngines } = await api.pageHandler.getSearchEngines()
      if (active && sequence === request) setSearchEngines(searchEngines)
    }
    const listener =
      api.pageCallbackRouter.onSearchEnginesChanged.addListener(update)
    update()
    return () => {
      active = false
      api.pageCallbackRouter.removeListener(listener)
    }
  }, [])

  const setEngineEnabled = React.useCallback(
    (engine: string, enabled: boolean) => {
      setConfig((previous) => {
        const next = { ...previous, [engine]: enabled }
        localStorage.setItem(ENABLED_SEARCH_ENGINES_KEY, JSON.stringify(next))
        return next
      })
    },
    [],
  )

  return (
    <EngineContext.Provider
      value={{
        searchEngines,
        engineConfig: config,
        setEngineConfig: setEngineEnabled,
      }}
    >
      {props.children}
    </EngineContext.Provider>
  )
}

export function useEngineContext() {
  return React.useContext(EngineContext)
}
