using System.Xml.Linq;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// 生成 Apple Shortcuts 的 XML plist 格式 .shortcut 文件
///
/// 两种模式：
/// 1. iCloud 模板模式（推荐）：生成通用模板，首次运行从剪贴板读取 JSON 配置
/// 2. 直接下载模式（兜底）：token 预嵌入，但 iOS 15+ 可能拒绝未签名文件
/// </summary>
public static class ShortcutPlistGenerator
{
    /// <summary>当前快捷指令模板版本，更新模板逻辑时递增</summary>
    public const int CurrentVersion = 2;

    /// <summary>
    /// 生成预嵌入 token 的 .shortcut 文件（直接下载模式，兜底用）
    /// </summary>
    public static string Generate(string shortcutName, string token, string serverUrl)
    {
        var endpoint = $"{serverUrl}/api/shortcuts/collect";
        var versionCheckUrl = $"{serverUrl}/api/shortcuts/version-check";

        var actions = new XElement("array",
            // ── Action 0: Comment ──
            Action("is.workflow.actions.comment",
                Param("WFCommentActionText",
                    $"PrdAgent 收藏快捷指令 v{CurrentVersion}\n请勿修改下方 Config 字典中的值")),

            // ── Action 1: Dictionary "Config" ──
            DictionaryAction(
                ("token", token),
                ("endpoint", endpoint),
                ("version", CurrentVersion.ToString()),
                ("update", versionCheckUrl),
                ("name", shortcutName)
            ),

            // ── Action 2: Set Variable "Config" ──
            SetVariableFromPreviousAction("Config", "词典"),

            // ── Action 3-14: Version check (same as before) ──
            GetDictionaryValue("version", "Config"),
            SetVariableFromPreviousAction("LocalVersion", "词典值"),
            GetDictionaryValue("update", "Config"),
            SimpleGetUrl(),
            SetVariableFromPreviousAction("UpdateInfo", "URL 的内容"),
            GetDictionaryValue("version", "UpdateInfo"),
            SetVariableFromPreviousAction("RemoteVersion", "词典值"),
            IfNumberGreaterThan("RemoteVersion", "LocalVersion"),
            GetDictionaryValue("download", "UpdateInfo"),
            ShowAlert("快捷指令有新版本可用，点击「好」更新", "发现新版本"),
            OpenUrlFromPreviousAction(),
            EndIf(),

            // ── Main logic: Get input and POST ──
            SetVariableAction("__INPUT__", ExtensionInputAttachment()),
            PostToCollect(endpoint, token, "\uFFFC"),
            GetDictionaryValueFromPreviousAction("message"),
            ShowNotification(shortcutName)
        );

        return BuildPlist(actions);
    }

    /// <summary>
    /// 生成 iCloud 模板用的 .shortcut 文件
    /// 首次运行时从剪贴板读取 JSON 配置 {"token":"scs-xxx","endpoint":"...","name":"..."}
    /// 配置保存到 iCloud Drive 的 Shortcuts/ 目录
    /// </summary>
    public static string GenerateTemplate(string templateName)
    {
        // 配置文件路径：iCloud Drive / Shortcuts / prdagent_config.json
        var configFileName = "prdagent_config.txt";

        var actions = new XElement("array",
            // ── Comment ──
            Action("is.workflow.actions.comment",
                Param("WFCommentActionText",
                    $"PrdAgent 收藏快捷指令模板 v{CurrentVersion}\n首次运行请先在安装页复制配置\n配置存储在: iCloud Drive/Shortcuts/{configFileName}")),

            // ══════════════════════════════════════
            // 读取已保存的配置（如果有）
            // ══════════════════════════════════════

            // Action: Get file at Shortcuts/prdagent_config.txt
            GetFileFromShortcutsFolder(configFileName),
            SetVariableFromPreviousAction("SavedConfig", "文件"),

            // If SavedConfig has value → 跳到主逻辑
            // If SavedConfig is empty → 从剪贴板读取配置
            IfVariableHasNoValue("SavedConfig"),

            // ══════════════════════════════════════
            // 首次运行：从剪贴板读取配置
            // ══════════════════════════════════════

            // Get Clipboard
            Action("is.workflow.actions.getclipboard"),
            SetVariableFromPreviousAction("ClipboardContent", "剪贴板"),

            // Show Alert: 确认从剪贴板导入
            ShowAlert(
                "检测到剪贴板中有配置信息，是否导入？\n\n如未复制配置，请返回安装页点击「复制配置」",
                "首次配置"),

            // Get Dictionary from ClipboardContent (parse JSON)
            GetDictionaryFromInput("ClipboardContent"),
            SetVariableFromPreviousAction("ParsedConfig", "词典"),

            // Get token from parsed config
            GetDictionaryValue("token", "ParsedConfig"),
            SetVariableFromPreviousAction("CheckToken", "词典值"),

            // If token is empty → show error
            IfVariableHasNoValue("CheckToken"),
            ShowAlert("剪贴板中没有有效配置。\n\n请返回安装页，点击「复制配置」，再重新运行此快捷指令。", "配置无效"),
            ExitShortcut(),
            EndIf(),

            // Save config to file (Shortcuts/prdagent_config.txt)
            // Use the clipboard content (JSON string) directly
            GetVariable("ClipboardContent"),
            SaveToShortcutsFolder(configFileName),

            // Set SavedConfig = ClipboardContent for subsequent use
            GetVariable("ClipboardContent"),
            SetVariableFromPreviousAction("SavedConfig", "变量"),

            ShowNotification("配置已保存，之后分享时选择此快捷指令即可收藏"),

            // End If (first run check)
            EndIf(),

            // ══════════════════════════════════════
            // 主逻辑：解析配置 + POST 收藏
            // ══════════════════════════════════════

            // Parse saved config as Dictionary
            GetDictionaryFromInput("SavedConfig"),
            SetVariableFromPreviousAction("Config", "词典"),

            // Extract fields
            GetDictionaryValue("token", "Config"),
            SetVariableFromPreviousAction("Token", "词典值"),

            GetDictionaryValue("endpoint", "Config"),
            SetVariableFromPreviousAction("Endpoint", "词典值"),

            GetDictionaryValue("name", "Config"),
            SetVariableFromPreviousAction("ShortcutName", "词典值"),

            // Get Shortcut Input (shared content)
            SetVariableAction("__INPUT__", ExtensionInputAttachment()),

            // POST to collect endpoint with dynamic token and endpoint
            PostToCollectDynamic(),

            // Get message from response
            GetDictionaryValueFromPreviousAction("message"),

            // Show notification
            ShowNotificationDynamic()
        );

        return BuildPlist(actions);
    }

    #region Plist Structure

    private static string BuildPlist(XElement actions)
    {
        var plist = new XDocument(
            new XDeclaration("1.0", "UTF-8", null),
            new XDocumentType("plist", "-//Apple//DTD PLIST 1.0//EN",
                "http://www.apple.com/DTDs/PropertyList-1.0.dtd", null),
            new XElement("plist",
                new XAttribute("version", "1.0"),
                new XElement("dict",
                    Key("WFWorkflowMinimumClientVersionString"), Str("900"),
                    Key("WFWorkflowMinimumClientVersion"), Int(900),
                    Key("WFWorkflowClientVersion"), Str("2605.0.5"),
                    Key("WFWorkflowHasShortcutInputVariables"), new XElement("true"),
                    Key("WFWorkflowIcon"), new XElement("dict",
                        Key("WFWorkflowIconStartColor"), Int(463140863),
                        Key("WFWorkflowIconGlyphNumber"), Int(59771)
                    ),
                    Key("WFWorkflowActions"), actions,
                    Key("WFWorkflowInputContentItemClasses"), new XElement("array",
                        Str("WFURLContentItem"),
                        Str("WFStringContentItem"),
                        Str("WFSafariWebPageContentItem")
                    ),
                    Key("WFWorkflowTypes"), new XElement("array",
                        Str("ActionExtension")
                    ),
                    Key("WFWorkflowHasOutputFallback"), new XElement("false")
                )
            )
        );

        return plist.Declaration + "\n" + plist.ToString();
    }

    #endregion

    #region Plist Primitives

    private static XElement Key(string name) => new("key", name);
    private static XElement Str(string value) => new("string", value);
    private static XElement Int(int value) => new("integer", value);

    private static XElement Param(string key, string value) =>
        new XElement("wrapper", Key(key), Str(value));

    private static XElement Action(string identifier, params XElement[] parameters)
    {
        var paramsDict = new XElement("dict");
        foreach (var p in parameters)
        {
            if (p.Name == "wrapper")
            {
                foreach (var child in p.Elements())
                    paramsDict.Add(child);
            }
            else
            {
                paramsDict.Add(p);
            }
        }

        return new XElement("dict",
            Key("WFWorkflowActionIdentifier"), Str(identifier),
            Key("WFWorkflowActionParameters"), paramsDict
        );
    }

    #endregion

    #region Text Token Helpers

    private static XElement[] TextTokenString(string key, string value)
    {
        return new[]
        {
            Key(key),
            new XElement("dict",
                Key("Value"), new XElement("dict",
                    Key("attachmentsByRange"), new XElement("dict"),
                    Key("string"), Str(value)
                ),
                Key("WFSerializationType"), Str("WFTextTokenString")
            )
        };
    }

    private static XElement[] TextTokenWithVariable(string key, string varType, string varName)
    {
        return new[]
        {
            Key(key),
            new XElement("dict",
                Key("Value"), new XElement("dict",
                    Key("attachmentsByRange"), new XElement("dict",
                        Key("{0, 1}"), new XElement("dict",
                            Key("Type"), Str(varType),
                            Key("VariableName"), Str(varName)
                        )
                    ),
                    Key("string"), Str("\uFFFC")
                ),
                Key("WFSerializationType"), Str("WFTextTokenString")
            )
        };
    }

    private static XElement VariableAttachment(string varType, string varName)
    {
        return new XElement("dict",
            Key("Value"), new XElement("dict",
                Key("Type"), Str(varType),
                Key("VariableName"), Str(varName)
            ),
            Key("WFSerializationType"), Str("WFTextTokenAttachment")
        );
    }

    private static XElement ExtensionInputAttachment()
    {
        return new XElement("dict",
            Key("Value"), new XElement("dict",
                Key("Type"), Str("ExtensionInput")
            ),
            Key("WFSerializationType"), Str("WFTextTokenAttachment")
        );
    }

    #endregion

    #region Dictionary Field Helpers

    private static XElement[] DictionaryFieldValue(string key, params (string key, string value)[] items)
    {
        var fieldItems = new XElement("array");
        foreach (var (k, v) in items)
        {
            fieldItems.Add(new XElement("dict",
                Key("WFItemType"), Int(0),
                Key("WFKey"), new XElement("dict",
                    Key("Value"), new XElement("dict",
                        Key("attachmentsByRange"), new XElement("dict"),
                        Key("string"), Str(k)
                    ),
                    Key("WFSerializationType"), Str("WFTextTokenString")
                ),
                Key("WFValue"), new XElement("dict",
                    Key("Value"), new XElement("dict",
                        Key("attachmentsByRange"), new XElement("dict"),
                        Key("string"), Str(v)
                    ),
                    Key("WFSerializationType"), Str("WFTextTokenString")
                )
            ));
        }

        return new[]
        {
            Key(key),
            new XElement("dict",
                Key("Value"), new XElement("dict",
                    Key("WFDictionaryFieldValueItems"), fieldItems
                ),
                Key("WFSerializationType"), Str("WFDictionaryFieldValue")
            )
        };
    }

    private static XElement DictionaryFieldItemWithVariable(string key, string varType, string varName)
    {
        return new XElement("dict",
            Key("WFItemType"), Int(0),
            Key("WFKey"), new XElement("dict",
                Key("Value"), new XElement("dict",
                    Key("attachmentsByRange"), new XElement("dict"),
                    Key("string"), Str(key)
                ),
                Key("WFSerializationType"), Str("WFTextTokenString")
            ),
            Key("WFValue"), new XElement("dict",
                Key("Value"), new XElement("dict",
                    Key("attachmentsByRange"), new XElement("dict",
                        Key("{0, 1}"), new XElement("dict",
                            Key("Type"), Str(varType),
                            Key("VariableName"), Str(varName)
                        )
                    ),
                    Key("string"), Str("\uFFFC")
                ),
                Key("WFSerializationType"), Str("WFTextTokenString")
            )
        );
    }

    #endregion

    #region Action Builders

    private static XElement DictionaryAction(params (string key, string value)[] items)
    {
        var paramsDict = new XElement("dict");
        foreach (var el in DictionaryFieldValue("WFItems", items))
            paramsDict.Add(el);

        return new XElement("dict",
            Key("WFWorkflowActionIdentifier"), Str("is.workflow.actions.dictionary"),
            Key("WFWorkflowActionParameters"), paramsDict
        );
    }

    private static XElement SetVariableFromPreviousAction(string variableName, string outputName)
    {
        return new XElement("dict",
            Key("WFWorkflowActionIdentifier"), Str("is.workflow.actions.setvariable"),
            Key("WFWorkflowActionParameters"), new XElement("dict",
                Key("WFVariableName"), Str(variableName)
            )
        );
    }

    private static XElement SetVariableAction(string variableName, XElement inputAttachment)
    {
        return new XElement("dict",
            Key("WFWorkflowActionIdentifier"), Str("is.workflow.actions.setvariable"),
            Key("WFWorkflowActionParameters"), new XElement("dict",
                Key("WFVariableName"), Str(variableName),
                Key("WFInput"), inputAttachment
            )
        );
    }

    private static XElement GetVariable(string variableName)
    {
        return new XElement("dict",
            Key("WFWorkflowActionIdentifier"), Str("is.workflow.actions.getvariable"),
            Key("WFWorkflowActionParameters"), new XElement("dict",
                Key("WFVariable"), VariableAttachment("Variable", variableName)
            )
        );
    }

    private static XElement GetDictionaryValue(string dictKey, string variableName)
    {
        var paramsDict = new XElement("dict");
        foreach (var el in TextTokenString("WFDictionaryKey", dictKey))
            paramsDict.Add(el);
        paramsDict.Add(Key("WFInput"));
        paramsDict.Add(VariableAttachment("Variable", variableName));

        return new XElement("dict",
            Key("WFWorkflowActionIdentifier"), Str("is.workflow.actions.getvalueforkey"),
            Key("WFWorkflowActionParameters"), paramsDict
        );
    }

    private static XElement GetDictionaryValueFromPreviousAction(string dictKey)
    {
        var paramsDict = new XElement("dict");
        foreach (var el in TextTokenString("WFDictionaryKey", dictKey))
            paramsDict.Add(el);

        return new XElement("dict",
            Key("WFWorkflowActionIdentifier"), Str("is.workflow.actions.getvalueforkey"),
            Key("WFWorkflowActionParameters"), paramsDict
        );
    }

    /// <summary>Get Dictionary from Input (parse JSON/text as dictionary)</summary>
    private static XElement GetDictionaryFromInput(string variableName)
    {
        return new XElement("dict",
            Key("WFWorkflowActionIdentifier"), Str("is.workflow.actions.detect.dictionary"),
            Key("WFWorkflowActionParameters"), new XElement("dict",
                Key("WFInput"), VariableAttachment("Variable", variableName)
            )
        );
    }

    private static XElement SimpleGetUrl()
    {
        return new XElement("dict",
            Key("WFWorkflowActionIdentifier"), Str("is.workflow.actions.downloadurl"),
            Key("WFWorkflowActionParameters"), new XElement("dict")
        );
    }

    private static XElement IfNumberGreaterThan(string variableA, string variableB)
    {
        var paramsDict = new XElement("dict",
            Key("WFCondition"), Int(2),
            Key("WFControlFlowMode"), Int(0),
            Key("WFInput"), new XElement("dict",
                Key("Type"), Str("Variable"),
                Key("Variable"), VariableAttachment("Variable", variableA)
            ),
            Key("WFNumberValue"), VariableAttachment("Variable", variableB)
        );

        return new XElement("dict",
            Key("WFWorkflowActionIdentifier"), Str("is.workflow.actions.conditional"),
            Key("WFWorkflowActionParameters"), paramsDict
        );
    }

    /// <summary>If variable has no value (is empty)</summary>
    private static XElement IfVariableHasNoValue(string variableName)
    {
        return new XElement("dict",
            Key("WFWorkflowActionIdentifier"), Str("is.workflow.actions.conditional"),
            Key("WFWorkflowActionParameters"), new XElement("dict",
                Key("WFControlFlowMode"), Int(0),
                Key("WFCondition"), Int(100), // 100 = "does not have any value"
                Key("WFInput"), new XElement("dict",
                    Key("Type"), Str("Variable"),
                    Key("Variable"), VariableAttachment("Variable", variableName)
                )
            )
        );
    }

    private static XElement EndIf()
    {
        return new XElement("dict",
            Key("WFWorkflowActionIdentifier"), Str("is.workflow.actions.conditional"),
            Key("WFWorkflowActionParameters"), new XElement("dict",
                Key("WFControlFlowMode"), Int(2)
            )
        );
    }

    /// <summary>Exit Shortcut (stop execution)</summary>
    private static XElement ExitShortcut()
    {
        return new XElement("dict",
            Key("WFWorkflowActionIdentifier"), Str("is.workflow.actions.exit"),
            Key("WFWorkflowActionParameters"), new XElement("dict")
        );
    }

    private static XElement ShowAlert(string body, string title)
    {
        return new XElement("dict",
            Key("WFWorkflowActionIdentifier"), Str("is.workflow.actions.alert"),
            Key("WFWorkflowActionParameters"), new XElement("dict",
                Key("WFAlertActionMessage"), Str(body),
                Key("WFAlertActionTitle"), Str(title)
            )
        );
    }

    private static XElement OpenUrlFromPreviousAction()
    {
        return new XElement("dict",
            Key("WFWorkflowActionIdentifier"), Str("is.workflow.actions.openurl"),
            Key("WFWorkflowActionParameters"), new XElement("dict")
        );
    }

    private static XElement ShowNotification(string title)
    {
        return new XElement("dict",
            Key("WFWorkflowActionIdentifier"), Str("is.workflow.actions.notification"),
            Key("WFWorkflowActionParameters"), new XElement("dict",
                Key("WFNotificationActionTitle"), Str(title),
                Key("WFNotificationActionBody"), Str("已收藏 ✅")
            )
        );
    }

    /// <summary>Show notification with dynamic title from ShortcutName variable</summary>
    private static XElement ShowNotificationDynamic()
    {
        var paramsDict = new XElement("dict");
        foreach (var el in TextTokenWithVariable("WFNotificationActionTitle", "Variable", "ShortcutName"))
            paramsDict.Add(el);
        paramsDict.Add(Key("WFNotificationActionBody"));
        paramsDict.Add(Str("已收藏 ✅"));

        return new XElement("dict",
            Key("WFWorkflowActionIdentifier"), Str("is.workflow.actions.notification"),
            Key("WFWorkflowActionParameters"), paramsDict
        );
    }

    /// <summary>Get file from Shortcuts folder in iCloud Drive</summary>
    private static XElement GetFileFromShortcutsFolder(string fileName)
    {
        var paramsDict = new XElement("dict",
            Key("WFFileErrorIfNotFound"), new XElement("false")
        );
        foreach (var el in TextTokenString("WFFilePath", fileName))
            paramsDict.Add(el);

        return new XElement("dict",
            Key("WFWorkflowActionIdentifier"), Str("is.workflow.actions.documentpicker.open"),
            Key("WFWorkflowActionParameters"), paramsDict
        );
    }

    /// <summary>Save file to Shortcuts folder in iCloud Drive</summary>
    private static XElement SaveToShortcutsFolder(string fileName)
    {
        var paramsDict = new XElement("dict",
            Key("WFAskWhereToSave"), new XElement("false"),
            Key("WFFileOverwrite"), new XElement("true")
        );
        foreach (var el in TextTokenString("WFFileDestinationPath", fileName))
            paramsDict.Add(el);

        return new XElement("dict",
            Key("WFWorkflowActionIdentifier"), Str("is.workflow.actions.documentpicker.save"),
            Key("WFWorkflowActionParameters"), paramsDict
        );
    }

    private static XElement PostToCollect(string endpoint, string token, string objectChar)
    {
        var paramsDict = new XElement("dict",
            Key("WFURL"), Str(endpoint),
            Key("WFHTTPMethod"), Str("POST"),
            Key("WFHTTPBodyType"), Str("JSON"),
            Key("ShowHeaders"), new XElement("true")
        );

        foreach (var el in DictionaryFieldValue("WFHTTPHeaders",
            ("Authorization", $"Bearer {token}"),
            ("Content-Type", "application/json")))
        {
            paramsDict.Add(el);
        }

        var bodyItems = new XElement("array",
            DictionaryFieldItemWithVariable("url", "Variable", "__INPUT__"),
            DictionaryFieldItemWithVariable("text", "Variable", "__INPUT__")
        );

        paramsDict.Add(Key("WFJSONValues"));
        paramsDict.Add(new XElement("dict",
            Key("Value"), new XElement("dict",
                Key("WFDictionaryFieldValueItems"), bodyItems
            ),
            Key("WFSerializationType"), Str("WFDictionaryFieldValue")
        ));

        return new XElement("dict",
            Key("WFWorkflowActionIdentifier"), Str("is.workflow.actions.downloadurl"),
            Key("WFWorkflowActionParameters"), paramsDict
        );
    }

    /// <summary>POST to collect endpoint using dynamic Token and Endpoint variables</summary>
    private static XElement PostToCollectDynamic()
    {
        var paramsDict = new XElement("dict");

        // URL from Endpoint variable
        foreach (var el in TextTokenWithVariable("WFURL", "Variable", "Endpoint"))
            paramsDict.Add(el);

        paramsDict.Add(Key("WFHTTPMethod"));
        paramsDict.Add(Str("POST"));
        paramsDict.Add(Key("WFHTTPBodyType"));
        paramsDict.Add(Str("JSON"));
        paramsDict.Add(Key("ShowHeaders"));
        paramsDict.Add(new XElement("true"));

        // Headers with dynamic token: "Bearer " + Token variable
        // Build Authorization header value as "Bearer {Token}"
        var authHeaderValue = new XElement("dict",
            Key("Value"), new XElement("dict",
                Key("attachmentsByRange"), new XElement("dict",
                    Key("{7, 1}"), new XElement("dict",
                        Key("Type"), Str("Variable"),
                        Key("VariableName"), Str("Token")
                    )
                ),
                Key("string"), Str("Bearer \uFFFC")
            ),
            Key("WFSerializationType"), Str("WFTextTokenString")
        );

        var headerItems = new XElement("array",
            new XElement("dict",
                Key("WFItemType"), Int(0),
                Key("WFKey"), new XElement("dict",
                    Key("Value"), new XElement("dict",
                        Key("attachmentsByRange"), new XElement("dict"),
                        Key("string"), Str("Authorization")
                    ),
                    Key("WFSerializationType"), Str("WFTextTokenString")
                ),
                Key("WFValue"), authHeaderValue
            ),
            new XElement("dict",
                Key("WFItemType"), Int(0),
                Key("WFKey"), new XElement("dict",
                    Key("Value"), new XElement("dict",
                        Key("attachmentsByRange"), new XElement("dict"),
                        Key("string"), Str("Content-Type")
                    ),
                    Key("WFSerializationType"), Str("WFTextTokenString")
                ),
                Key("WFValue"), new XElement("dict",
                    Key("Value"), new XElement("dict",
                        Key("attachmentsByRange"), new XElement("dict"),
                        Key("string"), Str("application/json")
                    ),
                    Key("WFSerializationType"), Str("WFTextTokenString")
                )
            )
        );

        paramsDict.Add(Key("WFHTTPHeaders"));
        paramsDict.Add(new XElement("dict",
            Key("Value"), new XElement("dict",
                Key("WFDictionaryFieldValueItems"), headerItems
            ),
            Key("WFSerializationType"), Str("WFDictionaryFieldValue")
        ));

        // JSON Body
        var bodyItems = new XElement("array",
            DictionaryFieldItemWithVariable("url", "Variable", "__INPUT__"),
            DictionaryFieldItemWithVariable("text", "Variable", "__INPUT__")
        );

        paramsDict.Add(Key("WFJSONValues"));
        paramsDict.Add(new XElement("dict",
            Key("Value"), new XElement("dict",
                Key("WFDictionaryFieldValueItems"), bodyItems
            ),
            Key("WFSerializationType"), Str("WFDictionaryFieldValue")
        ));

        return new XElement("dict",
            Key("WFWorkflowActionIdentifier"), Str("is.workflow.actions.downloadurl"),
            Key("WFWorkflowActionParameters"), paramsDict
        );
    }

    #endregion
}
