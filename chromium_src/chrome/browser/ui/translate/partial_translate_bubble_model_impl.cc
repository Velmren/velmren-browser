// Copyright (c) 2026 The Velmren Authors. All rights reserved.
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this file,
// You can obtain one at https://mozilla.org/MPL/2.0/.

// A new selection must be detected independently, even when keyboard
// interaction reuses an existing bubble. Explicit language changes keep their
// native state.
#define BRAVE_PARTIAL_TRANSLATE_BUBBLE_MODEL_IMPL_SET_SOURCE_TEXT \
  initial_request_completed_ = false;

#include <chrome/browser/ui/translate/partial_translate_bubble_model_impl.cc>

#undef BRAVE_PARTIAL_TRANSLATE_BUBBLE_MODEL_IMPL_SET_SOURCE_TEXT
