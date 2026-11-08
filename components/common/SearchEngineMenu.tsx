// Copyright (c) 2026 The Brave Authors. All rights reserved.
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this file,
// You can obtain one at https://mozilla.org/MPL/2.0/.

import * as React from 'react'
import Floating from '@brave/leo/react/floating'
import { color, font, radius, spacing } from '@brave/leo/tokens/css/variables'
import { scoped } from './scoped_css'

interface Props<T> {
  engines: T[]
  selectedEngine?: T | null
  engineKey: (engine: T) => string
  engineName: (engine: T) => string
  renderIcon: (engine: T) => React.ReactNode
  label: string
  description: string
  customizeLabel: string
  browserDefaultLabel: string
  onSelectEngine: (engine: T) => void
  onCustomizeClick: () => void
}

const style = scoped.css`
  .engine-icon {
    --leo-icon-size: 20px;
    width: 20px;
    height: 20px;
    display: block;
  }
  button, a {
    font: inherit;
    color: inherit;
  }
  button {
    background: transparent;
    border: 0;
    cursor: pointer;
  }
  .trigger {
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: ${radius.s};
    width: 40px;
    height: 40px;
  }
  :is(button, a):focus-visible {
    outline: 2px solid ${color.text.primary};
    outline-offset: -2px;
  }
  .menu {
    display: flex;
    flex-direction: column;
    width: 280px;
    max-width: calc(100vw - 32px);
    max-height: min(480px, calc(100vh - 32px));
    overflow-y: auto;
    padding: ${spacing.s};
    border: 1px solid ${color.divider.subtle};
    border-radius: ${radius.m};
    background: ${color.container.background};
    color: ${color.text.primary};
    font: ${font.default.regular};
  }
  .description {
    margin: 0;
    padding: ${spacing.m};
    color: ${color.text.secondary};
    font: ${font.small.regular};
  }
  .item {
    display: flex;
    align-items: center;
    gap: ${spacing.m};
    padding: ${spacing.m};
    min-height: 40px;
    text-align: start;
    text-decoration: none;
    border-radius: ${radius.s};
  }
  .trigger:hover, .item:hover, .item[aria-checked=true] {
    background: ${color.container.highlight};
  }
`

// Shared by both NTPs so their keyboard and screen reader behavior agree.
export function SearchEngineMenu<T>(props: Props<T>) {
  const [open, setOpen] = React.useState(false)
  const trigger = React.useRef<HTMLButtonElement>(null)
  const menu = React.useRef<HTMLDivElement>(null)
  const id = React.useId()

  function close(restoreFocus: boolean) {
    setOpen(false)
    if (restoreFocus) trigger.current?.focus()
  }

  React.useEffect(() => {
    if (!open) return
    const selected = menu.current?.querySelector<HTMLElement>(
      '[aria-checked=true]',
    )
    const first = menu.current?.querySelector<HTMLElement>('[role^=menuitem]')
    ;(selected ?? first)?.focus()
    const outside = (event: Event) => {
      if (
        !event.composedPath().includes(menu.current!)
        && !event.composedPath().includes(trigger.current!)
      ) {
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('focusin', outside)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('focusin', outside)
    }
  }, [open])

  function handleKeyDown(event: React.KeyboardEvent) {
    // The legacy search dialog also listens for Enter at document level.
    event.stopPropagation()
    if (event.key === 'Escape') {
      event.preventDefault()
      close(true)
    } else if (event.key === 'Tab') {
      close(true)
    } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault()
      const items = Array.from(
        menu.current?.querySelectorAll<HTMLElement>('[role^=menuitem]') ?? [],
      )
      const current = items.indexOf(document.activeElement as HTMLElement)
      const index =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? items.length - 1
            : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length)
              % items.length
      items[index]?.focus()
    }
  }

  return (
    <div data-css-scope={style.scope}>
      <button
        type='button'
        className='trigger'
        ref={trigger}
        aria-label={props.label}
        title={props.label}
        aria-haspopup='menu'
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={(event) => {
          event.stopPropagation()
          setOpen((value) => !value)
        }}
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            setOpen(true)
          }
        }}
      >
        <span aria-hidden='true'>
          {props.selectedEngine && props.renderIcon(props.selectedEngine)}
        </span>
      </button>
      {open && (
        <Floating
          target={trigger.current!}
          autoUpdate
          positionStrategy='fixed'
          placement='bottom-start'
        >
          <div data-css-scope={style.scope}>
            <div
              className='menu'
              id={id}
              ref={menu}
              role='menu'
              aria-label={props.label}
              aria-describedby={`${id}-description`}
              onKeyDown={handleKeyDown}
              onClick={(event) => event.stopPropagation()}
            >
              <p
                className='description'
                id={`${id}-description`}
              >
                {props.description}
              </p>
              {props.engines.map((engine) => (
                <button
                  type='button'
                  className='item'
                  role='menuitemradio'
                  tabIndex={-1}
                  aria-checked={
                    !!props.selectedEngine
                    && props.engineKey(engine)
                      === props.engineKey(props.selectedEngine)
                  }
                  key={props.engineKey(engine)}
                  onClick={() => {
                    close(true)
                    props.onSelectEngine(engine)
                  }}
                >
                  <span aria-hidden='true'>{props.renderIcon(engine)}</span>
                  {props.engineName(engine)}
                </button>
              ))}
              <button
                type='button'
                className='item'
                role='menuitem'
                tabIndex={-1}
                onClick={() => {
                  close(false)
                  props.onCustomizeClick()
                }}
              >
                {props.customizeLabel}
              </button>
              <a
                className='item'
                role='menuitem'
                tabIndex={-1}
                href='chrome://settings/searchEngines'
              >
                {props.browserDefaultLabel}
              </a>
            </div>
          </div>
        </Floating>
      )}
    </div>
  )
}
