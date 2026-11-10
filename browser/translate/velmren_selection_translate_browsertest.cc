// Copyright (c) 2026 The Velmren Authors. All rights reserved.
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this file,
// You can obtain one at https://mozilla.org/MPL/2.0/.

#include <algorithm>
#include <atomic>
#include <memory>
#include <string>
#include <string_view>
#include <tuple>
#include <vector>

#include "base/command_line.h"
#include "base/functional/bind.h"
#include "base/logging.h"
#include "base/strings/utf_string_conversions.h"
#include "base/test/run_until.h"
#include "base/test/scoped_feature_list.h"
#include "base/values.h"
#include "brave/components/translate/core/common/brave_translate_features.h"
#include "build/build_config.h"
#include "chrome/app/chrome_command_ids.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/renderer_context_menu/render_view_context_menu_browsertest_util.h"
#include "chrome/browser/renderer_context_menu/render_view_context_menu_test_util.h"
#include "chrome/browser/search_engines/template_url_service_factory.h"
#include "chrome/browser/translate/chrome_translate_client.h"
#include "chrome/browser/ui/tabs/tab_strip_model.h"
#include "chrome/browser/ui/translate/partial_translate_bubble_model.h"
#include "chrome/browser/ui/ui_features.h"
#include "chrome/browser/ui/views/translate/partial_translate_bubble_view.h"
#include "chrome/browser/ui/views/translate/translate_bubble_controller.h"
#include "chrome/common/chrome_isolated_world_ids.h"
#include "chrome/test/base/in_process_browser_test.h"
#include "chrome/test/base/search_test_utils.h"
#include "chrome/test/base/ui_test_utils.h"
#include "components/policy/core/browser/browser_policy_connector.h"
#include "components/policy/core/common/mock_configuration_policy_provider.h"
#include "components/policy/core/common/policy_map.h"
#include "components/policy/policy_constants.h"
#include "components/prefs/pref_service.h"
#include "components/search_engines/template_url.h"
#include "components/search_engines/template_url_data.h"
#include "components/search_engines/template_url_service.h"
#include "components/translate/core/browser/language_state.h"
#include "components/translate/core/browser/translate_manager.h"
#include "components/translate/core/browser/translate_pref_names.h"
#include "components/translate/core/browser/translate_prefs.h"
#include "components/translate/core/common/translate_errors.h"
#include "components/translate/core/common/translate_features.h"
#include "content/public/browser/context_menu_params.h"
#include "content/public/browser/web_contents.h"
#include "content/public/test/browser_test.h"
#include "content/public/test/browser_test_utils.h"
#include "content/public/test/url_loader_interceptor.h"
#include "net/base/mock_network_change_notifier.h"
#include "net/base/network_change_notifier.h"
#include "net/http/http_status_code.h"
#include "net/test/embedded_test_server/embedded_test_server.h"
#include "net/test/embedded_test_server/http_request.h"
#include "net/test/embedded_test_server/http_response.h"
#include "net/url_request/referrer_policy.h"
#include "services/network/public/cpp/resource_request.h"
#include "services/network/public/mojom/fetch_api.mojom-shared.h"
#include "services/network/test/test_utils.h"
#include "testing/gmock/include/gmock/gmock.h"
#include "testing/gtest/include/gtest/gtest.h"
#include "third_party/blink/public/common/input/web_input_event.h"
#include "third_party/blink/public/common/input/web_mouse_event.h"
#include "third_party/blink/public/mojom/forms/form_control_type.mojom-shared.h"
#include "ui/gfx/geometry/point.h"
#include "ui/menus/simple_menu_model.h"
#include "ui/views/controls/label.h"
#include "ui/views/test/widget_test.h"
#include "ui/views/view.h"
#include "ui/views/view_utils.h"
#include "ui/views/widget/widget.h"
#include "url/gurl.h"

#if BUILDFLAG(IS_WIN)
#include "ui/accessibility/platform/ax_platform_node_win.h"
#endif

namespace {

constexpr char16_t kSelection[] = u"Please send the build & release notes.";
constexpr char16_t kTranslation[] =
    u"Пожалуйста, пришлите сборку и примечания к выпуску.";
constexpr char16_t kSecondSelection[] =
    u"Could you review the update tomorrow?";
constexpr char16_t kSecondTranslation[] =
    u"Не могли бы вы проверить обновление завтра?";
// Test-only opt-in: the source text is the public synthetic fixture above.
constexpr char kLiveServiceSwitch[] = "velmren-selection-live-service";
constexpr char kTranslateURL[] =
    "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto"
    "&tl=ru&dt=t&ie=UTF-8&oe=UTF-8";

// Synthetic chat, not Discord. Unselected content and the private-looking URL
// are sentinels for accidental disclosure in the translation request.
constexpr char kChatHTML[] = R"html(
<!doctype html><html lang="ru"><meta charset="utf-8">
<title>Синтетический чат</title>
<body><p>Личные сообщения. Неотправленный текст: surrounding-content-secret.</p>
<p><span id="message">Please send the build &amp; release notes.</span></p>
<input id="password" type="password" value="password-secret">
<script>
document.addEventListener('contextmenu', event => {
  if (!event.shiftKey) event.preventDefault();
});
</script></body></html>
)html";

struct SearchProvider {
  const char* name;
  const char* url;
};

constexpr SearchProvider kSearchProviders[] = {
    {"Google", "https://www.google.com/search?q={searchTerms}"},
    {"Yandex", "https://yandex.ru/search/?text={searchTerms}"},
    {"Bing", "https://www.bing.com/search?q={searchTerms}"},
    {"DuckDuckGo", "https://duckduckgo.com/?q={searchTerms}"},
    {"Custom", "https://search.example.test/find?q={searchTerms}"},
    {"None", nullptr},
};

int CountTranslateItems(const ui::SimpleMenuModel& menu) {
  int count = 0;
  for (size_t i = 0; i < menu.GetItemCount(); ++i) {
    if (menu.GetCommandIdAt(i) == IDC_CONTENT_CONTEXT_PARTIAL_TRANSLATE) {
      ++count;
    }
  }
  return count;
}

bool HasTranslatedLabel(const views::View* view, std::u16string_view text) {
  if (const auto* label = views::AsViewClass<views::Label>(view);
      label && label->GetText() == text && label->GetVisible()) {
    return true;
  }
  return std::ranges::any_of(view->children(), [text](const auto& child) {
    return HasTranslatedLabel(child.get(), text);
  });
}

class VelmrenSelectionTranslateTestBase : public InProcessBrowserTest {
 public:
  void SetUp() override {
    std::vector<base::test::FeatureRef> enabled = {
        translate::kTranslateRecentTarget,
        translate::kPartialTranslateUseOnePlatformApi};
    std::vector<base::test::FeatureRef> disabled = {
        translate::kBraveEnableAutoTranslate};
    (TranslateFeatureEnabled() ? enabled : disabled)
        .push_back(translate::kUseBraveTranslateGo);
    (SimplifiedMenu() ? enabled : disabled)
        .push_back(features::kMenuSimplification);
    feature_list_.InitWithFeatures(enabled, disabled);
    InProcessBrowserTest::SetUp();
  }

  void SetUpInProcessBrowserTestFixture() override {
    InProcessBrowserTest::SetUpInProcessBrowserTestFixture();
    policy_provider_.SetDefaultReturns(true, true);
    policy::BrowserPolicyConnector::SetPolicyProviderForTesting(
        &policy_provider_);
  }

  void SetUpOnMainThread() override {
    InProcessBrowserTest::SetUpOnMainThread();
    network_change_notifier_ =
        std::make_unique<net::test::ScopedMockNetworkChangeNotifier>();
    SetOnline(true);
    embedded_test_server()->RegisterRequestHandler(base::BindRepeating(
        [](const net::test_server::HttpRequest& request)
            -> std::unique_ptr<net::test_server::HttpResponse> {
          if (request.GetURL().path() != "/private-chat") {
            return nullptr;
          }
          auto response =
              std::make_unique<net::test_server::BasicHttpResponse>();
          response->set_code(net::HTTP_OK);
          response->set_content_type("text/html; charset=utf-8");
          response->set_content(kChatHTML);
          return response;
        }));
    ASSERT_TRUE(embedded_test_server()->Start());
    // Default to intercepting the real browser-process request. Live service
    // tests require an explicit switch and use only the synthetic selection.
    if (!UsingLiveService()) {
      interceptor_ = std::make_unique<content::URLLoaderInterceptor>(
          base::BindRepeating(&VelmrenSelectionTranslateTestBase::Intercept,
                              base::Unretained(this)));
    }
  }

  void TearDownOnMainThread() override {
    if (auto* controller = TranslateBubbleController::From(browser())) {
      if (auto* bubble = controller->GetPartialTranslateBubble()) {
        views::test::WidgetDestroyedWaiter waiter(bubble->GetWidget());
        controller->CloseBubble();
        waiter.Wait();
        EXPECT_FALSE(controller->GetPartialTranslateBubble());
      }
    }
    interceptor_.reset();
    network_change_notifier_.reset();
    InProcessBrowserTest::TearDownOnMainThread();
  }

  void PostRunTestOnMainThread() override {
    InProcessBrowserTest::PostRunTestOnMainThread();
#if BUILDFLAG(IS_WIN)
    // Browser and tab windows close in the base post-run method. External
    // accessibility clients can release their COM references asynchronously.
    EXPECT_TRUE(base::test::RunUntil([] {
      return ui::AXPlatformNodeWin::GetCounts().ghost_nodes == 0;
    })) << ui::AXPlatformNodeWin::GetCounts().ghost_nodes
        << " Windows accessibility COM references remain after teardown.";
#endif
  }

 protected:
  virtual bool SimplifiedMenu() const { return false; }
  virtual bool TranslateFeatureEnabled() const { return true; }
  virtual bool LiveServiceEligible() const { return false; }

  bool UsingLiveService() const {
    return LiveServiceEligible() &&
           base::CommandLine::ForCurrentProcess()->HasSwitch(
               kLiveServiceSwitch);
  }

  content::WebContents* web_contents() {
    return browser()->tab_strip_model()->GetActiveWebContents();
  }

  TranslateBubbleController* controller() {
    return TranslateBubbleController::From(browser());
  }

  void PrepareChat(const char* page_language) {
    ASSERT_TRUE(ui_test_utils::NavigateToURL(
        browser(), embedded_test_server()->GetURL(
                       "/private-chat?channel=page-url-secret")));
    ASSERT_EQ("text/html", web_contents()->GetContentsMimeType());
    auto* client = ChromeTranslateClient::FromWebContents(web_contents());
    ASSERT_TRUE(client);
    client->GetTranslatePrefs()->SetRecentTargetLanguage("ru");
    ASSERT_TRUE(controller());
    controller()->CloseBubble();
    ASSERT_TRUE(base::test::RunUntil(
        [&] { return !controller()->GetTranslateBubble(); }));
    SelectMessage(kSelection);
    // Set the state after asynchronous setup, immediately before the menu is
    // built, so "unknown" really exercises translation before page detection.
    client->GetTranslateManager()->GetLanguageState()->LanguageDetermined(
        page_language, true);
    ASSERT_EQ(
        page_language,
        client->GetTranslateManager()->GetLanguageState()->source_language());
  }

  void SelectMessage(std::u16string_view text) {
    ASSERT_EQ(base::UTF16ToUTF8(text),
              content::EvalJs(web_contents(),
                              content::JsReplace(R"(
              (() => {
                document.getElementById('message').textContent = $1;
                const range = document.createRange();
                range.selectNodeContents(document.getElementById('message'));
                const selection = window.getSelection();
                selection.removeAllRanges();
                selection.addRange(range);
                return selection.toString();
              })();
              )",
                                                 base::UTF16ToUTF8(text)),
                              content::EXECUTE_SCRIPT_DEFAULT_OPTIONS,
                              ISOLATED_WORLD_ID_BRAVE_INTERNAL));
  }

  void SetSearchProvider(const SearchProvider& provider) {
    auto* service = TemplateURLServiceFactory::GetForProfile(GetProfile());
    ASSERT_TRUE(service);
    search_test_utils::WaitForTemplateURLServiceToLoad(service);
    if (!provider.url) {
      policy::PolicyMap policies;
      policies.Set(policy::key::kDefaultSearchProviderEnabled,
                   policy::POLICY_LEVEL_MANDATORY, policy::POLICY_SCOPE_USER,
                   policy::POLICY_SOURCE_CLOUD, base::Value(false), nullptr);
      policy_provider_.UpdateChromePolicy(policies);
      ASSERT_TRUE(base::test::RunUntil(
          [&] { return !service->GetDefaultSearchProvider(); }));
      return;
    }
    TemplateURLData data;
    data.SetShortName(base::UTF8ToUTF16(provider.name));
    data.SetKeyword(base::UTF8ToUTF16(provider.name));
    data.SetURL(provider.url);
    auto* template_url = service->Add(std::make_unique<TemplateURL>(data));
    ASSERT_TRUE(template_url);
    service->SetUserSelectedDefaultSearchProvider(template_url);
    ASSERT_EQ(template_url, service->GetDefaultSearchProvider());
  }

  std::unique_ptr<TestRenderViewContextMenu> CreateMenu(
      bool password_field = false,
      std::u16string_view selection_text = kSelection) {
    content::ContextMenuParams params;
    params.page_url = web_contents()->GetLastCommittedURL();
    params.frame_url = params.page_url;
    params.selection_text = selection_text;
    params.is_editable = password_field;
    if (password_field) {
      params.form_control_type = blink::mojom::FormControlType::kInputPassword;
    }
    // Follow Chromium's ContextMenuBrowserTest construction path, then exercise
    // the actual production menu and native bubble rather than a fake model.
    auto menu = std::make_unique<TestRenderViewContextMenu>(
        *web_contents()->GetPrimaryMainFrame(), params);
    menu->SetBrowser(browser());
    menu->Init();
    return menu;
  }

  void ExpectTranslatedBubble(
      std::u16string_view expected_source = kSelection,
      std::u16string_view expected_translation = kTranslation,
      int expected_request_count = 1) {
    ASSERT_TRUE(base::test::RunUntil([&] {
      auto* bubble = controller()->GetPartialTranslateBubble();
      return bubble &&
             bubble->GetViewState() ==
                 PartialTranslateBubbleModel::VIEW_STATE_AFTER_TRANSLATE;
    }));
    auto* bubble = controller()->GetPartialTranslateBubble();
    ASSERT_TRUE(bubble);
    EXPECT_TRUE(bubble->GetWidget()->IsVisible());
    EXPECT_EQ(translate::TranslateErrors::NONE, bubble->model()->GetError());
    EXPECT_EQ(expected_source, bubble->model()->GetSourceText());
    const std::u16string translated_text = bubble->model()->GetTargetText();
    if (UsingLiveService()) {
      EXPECT_FALSE(translated_text.empty());
      EXPECT_NE(expected_source, translated_text);
      EXPECT_TRUE(std::ranges::any_of(translated_text, [](char16_t character) {
        return character >= u'\u0400' && character <= u'\u04ff';
      }));
      LOG(INFO) << "Velmren selection live service: "
                << testing::UnitTest::GetInstance()->current_test_info()->name()
                << " source=" << base::UTF16ToUTF8(expected_source)
                << " result=" << base::UTF16ToUTF8(translated_text);
      RecordProperty("live_service_source", base::UTF16ToUTF8(expected_source));
      RecordProperty("live_service_result", base::UTF16ToUTF8(translated_text));
      RecordProperty("live_service_page_url",
                     web_contents()->GetLastCommittedURL().spec());
      RecordProperty("live_service_source_language",
                     bubble->model()->GetSourceLanguageCode());
      RecordProperty("live_service_target_language",
                     bubble->model()->GetTargetLanguageCode());
    } else {
      EXPECT_EQ(expected_translation, translated_text);
      EXPECT_EQ(expected_request_count, translation_requests_.load());
    }
    EXPECT_EQ("en", bubble->model()->GetSourceLanguageCode());
    EXPECT_EQ("ru", bubble->model()->GetTargetLanguageCode());
    EXPECT_TRUE(HasTranslatedLabel(bubble, translated_text));
  }

  void ExpectBlocked(TestRenderViewContextMenu& menu) {
    EXPECT_FALSE(menu.IsItemPresent(IDC_CONTENT_CONTEXT_PARTIAL_TRANSLATE));
    EXPECT_FALSE(
        menu.IsCommandIdEnabled(IDC_CONTENT_CONTEXT_PARTIAL_TRANSLATE));
    menu.ExecuteCommand(IDC_CONTENT_CONTEXT_PARTIAL_TRANSLATE, 0);
    EXPECT_FALSE(controller()->GetPartialTranslateBubble());
    EXPECT_EQ(0, translation_requests_.load());
  }

  void SetOnline(bool online) {
    network_change_notifier_->mock_network_change_notifier()->SetConnectionType(
        online ? net::NetworkChangeNotifier::CONNECTION_ETHERNET
               : net::NetworkChangeNotifier::CONNECTION_NONE);
  }

  void DisableTranslationByPolicy() {
    policy::PolicyMap policies;
    policies.Set(policy::key::kTranslateEnabled, policy::POLICY_LEVEL_MANDATORY,
                 policy::POLICY_SCOPE_USER, policy::POLICY_SOURCE_CLOUD,
                 base::Value(false), nullptr);
    policy_provider_.UpdateChromePolicy(policies);
    ASSERT_TRUE(base::test::RunUntil([&] {
      return GetProfile()->GetPrefs()->IsManagedPreference(
                 translate::prefs::kOfferTranslateEnabled) &&
             !GetProfile()->GetPrefs()->GetBoolean(
                 translate::prefs::kOfferTranslateEnabled);
    }));
  }

 private:
  bool Intercept(content::URLLoaderInterceptor::RequestParams* params) {
    const network::ResourceRequest& request = params->url_request;
    if (!request.url.DomainIs("translate.googleapis.com")) {
      return false;
    }
    const int request_number = ++translation_requests_;
    EXPECT_EQ(GURL(kTranslateURL), request.url);
    EXPECT_EQ("POST", request.method);
    EXPECT_EQ(request_number == 1 ? "q=Please+send+the+build+%26+release+notes."
                                  : "q=Could+you+review+the+update+tomorrow%3F",
              network::GetUploadData(request));
    EXPECT_TRUE(request.referrer.is_empty());
    EXPECT_EQ(net::ReferrerPolicy::NO_REFERRER, request.referrer_policy);
    EXPECT_FALSE(request.headers.HasHeader("Cookie"));
    EXPECT_FALSE(request.headers.HasHeader("Referer"));
    EXPECT_EQ(network::mojom::CredentialsMode::kOmit, request.credentials_mode);
    EXPECT_EQ(network::mojom::RedirectMode::kError, request.redirect_mode);
    content::URLLoaderInterceptor::WriteResponse(
        "HTTP/1.1 200 OK\nContent-Type: application/json; charset=utf-8\n\n",
        request_number == 1
            ? R"json([[["Пожалуйста, пришлите сборку и примечания к выпуску.",)json"
              R"json("Please send the build & release notes.",null,null,1]],null,"en"])json"
            : R"json([[["Не могли бы вы проверить обновление завтра?",)json"
              R"json("Could you review the update tomorrow?",null,null,1]],null,"en"])json",
        params->client.get());
    return true;
  }

  base::test::ScopedFeatureList feature_list_;
  testing::NiceMock<policy::MockConfigurationPolicyProvider> policy_provider_;
  std::unique_ptr<net::test::ScopedMockNetworkChangeNotifier>
      network_change_notifier_;
  std::unique_ptr<content::URLLoaderInterceptor> interceptor_;
  std::atomic<int> translation_requests_{0};
};

using TranslationCase = std::tuple<SearchProvider, const char*, bool>;

class VelmrenSelectionTranslateBrowserTest
    : public VelmrenSelectionTranslateTestBase,
      public testing::WithParamInterface<TranslationCase> {
 protected:
  bool SimplifiedMenu() const override { return std::get<2>(GetParam()); }
  bool LiveServiceEligible() const override { return true; }
};

IN_PROC_BROWSER_TEST_P(VelmrenSelectionTranslateBrowserTest,
                       NativeMenuTranslatesEnglishSelectionToRussian) {
  ASSERT_NO_FATAL_FAILURE(SetSearchProvider(std::get<0>(GetParam())));
  ASSERT_NO_FATAL_FAILURE(PrepareChat(std::get<1>(GetParam())));
  auto menu = CreateMenu();
  ASSERT_EQ(1, CountTranslateItems(menu->menu_model()));
  ASSERT_TRUE(menu->IsItemEnabled(IDC_CONTENT_CONTEXT_PARTIAL_TRANSLATE));
  menu->ExecuteCommand(IDC_CONTENT_CONTEXT_PARTIAL_TRANSLATE, 0);
  ExpectTranslatedBubble();
}

INSTANTIATE_TEST_SUITE_P(
    ProvidersAndPageLanguages,
    VelmrenSelectionTranslateBrowserTest,
    testing::Combine(testing::ValuesIn(kSearchProviders),
                     testing::Values("ru", "und"),
                     testing::Bool()),
    [](const testing::TestParamInfo<TranslationCase>& info) {
      return std::string(std::get<0>(info.param).name) +
             (std::string_view(std::get<1>(info.param)) == "ru"
                  ? "RussianPage"
                  : "UnknownPage") +
             (std::get<2>(info.param) ? "SimplifiedMenu" : "ClassicMenu");
    });

class VelmrenSelectionTranslateGuardsBrowserTest
    : public VelmrenSelectionTranslateTestBase,
      public testing::WithParamInterface<bool> {
 protected:
  bool SimplifiedMenu() const override { return GetParam(); }
};

IN_PROC_BROWSER_TEST_P(VelmrenSelectionTranslateGuardsBrowserTest,
                       PasswordSelectionCannotTranslate) {
  ASSERT_NO_FATAL_FAILURE(PrepareChat("ru"));
  auto menu = CreateMenu(/*password_field=*/true);
  ExpectBlocked(*menu);
}

IN_PROC_BROWSER_TEST_P(VelmrenSelectionTranslateGuardsBrowserTest,
                       ManagedPolicyBlocksMenuAndExecution) {
  ASSERT_NO_FATAL_FAILURE(PrepareChat("ru"));
  ASSERT_NO_FATAL_FAILURE(DisableTranslationByPolicy());
  auto menu = CreateMenu();
  ExpectBlocked(*menu);
}

IN_PROC_BROWSER_TEST_P(VelmrenSelectionTranslateGuardsBrowserTest,
                       OfflineBlocksMenuAndExecution) {
  ASSERT_NO_FATAL_FAILURE(PrepareChat("ru"));
  SetOnline(false);
  auto menu = CreateMenu();
  ExpectBlocked(*menu);
}

IN_PROC_BROWSER_TEST_P(VelmrenSelectionTranslateGuardsBrowserTest,
                       PolicyRevocationRechecksAlreadyOpenMenu) {
  ASSERT_NO_FATAL_FAILURE(PrepareChat("ru"));
  auto menu = CreateMenu();
  ASSERT_TRUE(menu->IsItemEnabled(IDC_CONTENT_CONTEXT_PARTIAL_TRANSLATE));
  ASSERT_NO_FATAL_FAILURE(DisableTranslationByPolicy());
  EXPECT_FALSE(menu->IsCommandIdEnabled(IDC_CONTENT_CONTEXT_PARTIAL_TRANSLATE));
  menu->ExecuteCommand(IDC_CONTENT_CONTEXT_PARTIAL_TRANSLATE, 0);
  EXPECT_FALSE(controller()->GetPartialTranslateBubble());
}

INSTANTIATE_TEST_SUITE_P(MenuVariants,
                         VelmrenSelectionTranslateGuardsBrowserTest,
                         testing::Bool());

class VelmrenSelectionTranslateFeatureOffBrowserTest
    : public VelmrenSelectionTranslateGuardsBrowserTest {
 protected:
  bool TranslateFeatureEnabled() const override { return false; }
};

IN_PROC_BROWSER_TEST_P(VelmrenSelectionTranslateFeatureOffBrowserTest,
                       DisabledFeatureBlocksMenuAndExecution) {
  ASSERT_NO_FATAL_FAILURE(PrepareChat("ru"));
  auto menu = CreateMenu();
  ExpectBlocked(*menu);
}

INSTANTIATE_TEST_SUITE_P(MenuVariants,
                         VelmrenSelectionTranslateFeatureOffBrowserTest,
                         testing::Bool());

IN_PROC_BROWSER_TEST_F(VelmrenSelectionTranslateTestBase,
                       ReusedNativeBubbleDetectsEachNewSelection) {
  ASSERT_NO_FATAL_FAILURE(SetSearchProvider(kSearchProviders[1]));
  ASSERT_NO_FATAL_FAILURE(PrepareChat("ru"));
  auto first_menu = CreateMenu();
  ASSERT_TRUE(first_menu->IsItemEnabled(IDC_CONTENT_CONTEXT_PARTIAL_TRANSLATE));
  first_menu->ExecuteCommand(IDC_CONTENT_CONTEXT_PARTIAL_TRANSLATE, 0);
  ASSERT_NO_FATAL_FAILURE(ExpectTranslatedBubble());
  auto* const first_bubble = controller()->GetPartialTranslateBubble();

  // Keyboard-driven selections can reuse the visible bubble. The Russian page
  // language must be only a hint for each new English selection, even after a
  // previous response detected English successfully.
  ASSERT_NO_FATAL_FAILURE(SelectMessage(kSecondSelection));
  ASSERT_EQ(first_bubble, controller()->GetPartialTranslateBubble());
  auto second_menu = CreateMenu(/*password_field=*/false, kSecondSelection);
  ASSERT_TRUE(
      second_menu->IsItemEnabled(IDC_CONTENT_CONTEXT_PARTIAL_TRANSLATE));
  second_menu->ExecuteCommand(IDC_CONTENT_CONTEXT_PARTIAL_TRANSLATE, 0);
  ASSERT_EQ(first_bubble, controller()->GetPartialTranslateBubble());
  ExpectTranslatedBubble(kSecondSelection, kSecondTranslation,
                         /*expected_request_count=*/2);
}

IN_PROC_BROWSER_TEST_F(VelmrenSelectionTranslateTestBase,
                       SyntheticChatShiftContextMenuUsesNativeBubble) {
  ASSERT_NO_FATAL_FAILURE(SetSearchProvider(kSearchProviders[1]));
  ASSERT_NO_FATAL_FAILURE(PrepareChat("ru"));
  // The fixture suppresses its ordinary DOM context menu, as chat applications
  // can do. Shift permits a real renderer-generated native context menu.
  EXPECT_EQ(false, content::EvalJs(web_contents(), R"(
    document.getElementById('message').dispatchEvent(
        new MouseEvent('contextmenu', {bubbles: true, cancelable: true}));
  )",
                                   content::EXECUTE_SCRIPT_DEFAULT_OPTIONS,
                                   ISOLATED_WORLD_ID_BRAVE_INTERNAL));
  content::SimulateEndOfPaintHoldingOnPrimaryMainFrame(web_contents());
  // Shift extends a selection to the mouse caret. Click its end so the real
  // renderer event preserves the entire selected fixture rather than its half.
  const auto selection_end = content::EvalJs(web_contents(), R"(
    (() => {
      const rects = getSelection().getRangeAt(0).getClientRects();
      const rect = rects[rects.length - 1];
      return [Math.ceil(rect.right) - 1, Math.round((rect.top + rect.bottom) / 2)];
    })();
  )");
  ASSERT_TRUE(selection_end.is_ok());
  const auto& point = selection_end.ExtractList();
  ASSERT_EQ(2U, point.size());
  ContextMenuWaiter menu_waiter(IDC_CONTENT_CONTEXT_PARTIAL_TRANSLATE);
  content::SimulateMouseClickAt(
      web_contents(), blink::WebInputEvent::kShiftKey,
      blink::WebMouseEvent::Button::kRight,
      gfx::Point(point[0].GetInt(), point[1].GetInt()));
  menu_waiter.WaitForMenuOpenAndClose();
  EXPECT_EQ(kSelection, menu_waiter.params().selection_text);
  EXPECT_EQ(1, std::ranges::count(menu_waiter.GetCapturedCommandIds(),
                                  IDC_CONTENT_CONTEXT_PARTIAL_TRANSLATE));
  ExpectTranslatedBubble();
}

}  // namespace
