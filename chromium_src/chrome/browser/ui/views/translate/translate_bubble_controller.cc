// Copyright (c) 2026 The Velmren Authors. All rights reserved.
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this file,
// You can obtain one at https://mozilla.org/MPL/2.0/.

#include "brave/components/velmren/selection_translate_delegate.h"
#include "components/translate/content/browser/partial_translate_manager.h"

// Keep the native bubble and manager. A null alternate delegate makes this
// provider-independent path authoritative even when OnePlatform is enabled.
#define BRAVE_TRANSLATE_BUBBLE_CONTROLLER_CREATE_PARTIAL_TRANSLATE_MANAGER \
  partial_translate_manager = std::make_unique<PartialTranslateManager>(   \
      std::make_unique<velmren::SelectionTranslateDelegate>(               \
          profile->GetURLLoaderFactory()),                                 \
      nullptr);

#include <chrome/browser/ui/views/translate/translate_bubble_controller.cc>

#undef BRAVE_TRANSLATE_BUBBLE_CONTROLLER_CREATE_PARTIAL_TRANSLATE_MANAGER
