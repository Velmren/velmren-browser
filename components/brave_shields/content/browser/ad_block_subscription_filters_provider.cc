// Copyright (c) 2021 The Brave Authors. All rights reserved.
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this file,
// You can obtain one at https://mozilla.org/MPL/2.0/.

#include "brave/components/brave_shields/content/browser/ad_block_subscription_filters_provider.h"

#include <string>
#include <utility>

#include "base/logging.h"
#include "base/task/sequenced_task_runner.h"
#include "base/task/single_thread_task_runner.h"
#include "base/task/thread_pool.h"
#include "brave/components/brave_shields/core/browser/ad_block_filters_provider.h"
#include "brave/components/brave_shields/core/common/adblock/rs/src/lib.rs.h"
#include "brave/components/velmren/public_filters.h"
#include "components/prefs/pref_service.h"
#include "ui/base/resource/resource_bundle.h"

namespace brave_shields {

namespace {

// static
void AddDATBufferToFilterSet(
    base::OnceCallback<void(const adblock::FilterListMetadata&)> on_metadata,
    const velmren::PublicFilterList* public_list,
    DATFileDataBuffer buffer,
    const perfetto::Flow& flow,
    rust::Box<adblock::FilterSet>* filter_set) {
  TRACE_EVENT("brave.adblock",
              "AddDATBufferToFilterSet_SubscriptionFiltersProvider", flow);
  if (public_list) {
    const std::string input(buffer.begin(), buffer.end());
    const auto processed = velmren::PreprocessPublicFilters(input);
    if (!processed) {
      LOG(ERROR) << "Invalid public filter list conditionals: "
                 << public_list->url;
      return;
    }
    buffer.assign(processed->begin(), processed->end());
  }
  auto result = (*filter_set)->add_filter_list_with_permissions(
      buffer, public_list ? public_list->permission_mask : 0);
  if (result.result_kind == adblock::ResultKind::Success) {
    std::move(on_metadata).Run(result.value.metadata);
  } else {
    VLOG(0) << "Subscription list parsing failed: "
            << result.error_message.c_str();
  }
}

}  // namespace

AdBlockSubscriptionFiltersProvider::AdBlockSubscriptionFiltersProvider(
    AdBlockFiltersProviderManager* manager,
    base::FilePath list_file,
    base::RepeatingCallback<void(const adblock::FilterListMetadata&)>
        on_metadata_retrieved,
    const velmren::PublicFilterList* public_list)
    : AdBlockFiltersProvider(public_list && public_list->is_default_engine,
                             manager),
      list_file_(list_file),
      public_list_(public_list),
      on_metadata_retrieved_(on_metadata_retrieved) {}

AdBlockSubscriptionFiltersProvider::~AdBlockSubscriptionFiltersProvider() =
    default;

void AdBlockSubscriptionFiltersProvider::LoadFilterSet(
    base::OnceCallback<
        void(base::OnceCallback<void(rust::Box<adblock::FilterSet>*)>)> cb) {
  const auto flow = perfetto::Flow::FromPointer(this);
  TRACE_EVENT("brave.adblock",
              "AdBlockSubscriptionFiltersProvider::LoadFilterSet", flow);
  base::ThreadPool::PostTaskAndReplyWithResult(
      FROM_HERE, {base::MayBlock()},
      base::BindOnce(&brave_component_updater::ReadDATFileData, list_file_),
      base::BindOnce(&AdBlockSubscriptionFiltersProvider::OnDATFileDataReady,
                     weak_factory_.GetWeakPtr(), std::move(cb), flow));
}

std::string AdBlockSubscriptionFiltersProvider::GetNameForDebugging() {
  return "AdBlockSubscriptionFiltersProvider";
}

void AdBlockSubscriptionFiltersProvider::OnDATFileDataReady(
    base::OnceCallback<
        void(base::OnceCallback<void(rust::Box<adblock::FilterSet>*)>)> cb,
    const perfetto::Flow& flow,
    const DATFileDataBuffer& dat_buf) {
  TRACE_EVENT("brave.adblock",
              "AdBlockSubscriptionFiltersProvider::OnDATFileDataReady", flow);
  DATFileDataBuffer filters = dat_buf;
  if (filters.empty() && public_list_ &&
      ui::ResourceBundle::HasSharedInstance()) {
    const auto bundled = ui::ResourceBundle::GetSharedInstance()
                             .LoadDataResourceString(public_list_->resource_id);
    filters.assign(bundled.begin(), bundled.end());
  }
  std::move(cb).Run(base::BindOnce(
      &AddDATBufferToFilterSet,
      base::BindOnce(
          [](scoped_refptr<base::SequencedTaskRunner> task_runner,
             base::RepeatingCallback<void(const adblock::FilterListMetadata&)>
                 on_metadata,
             const adblock::FilterListMetadata& metadata) {
            task_runner->PostTask(FROM_HERE,
                                  base::BindOnce(on_metadata, metadata));
          },
          base::SingleThreadTaskRunner::GetCurrentDefault(),
          on_metadata_retrieved_),
      public_list_.get(), std::move(filters), flow));
}

void AdBlockSubscriptionFiltersProvider::OnListAvailable() {
  NotifyObservers(engine_is_default_);
}

}  // namespace brave_shields
