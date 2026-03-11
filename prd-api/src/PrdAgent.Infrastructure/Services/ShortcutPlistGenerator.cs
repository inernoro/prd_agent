using System.Xml.Linq;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// 生成 Apple Shortcuts 的 XML plist 格式 .shortcut 文件
///
/// 采用"抖音解析"类似的模式：
/// 1. Config 字典（token/endpoint/version/update URL）
/// 2. 版本检查 + 自动更新提示
/// 3. 主逻辑：POST 收藏请求 + 通知
/// </summary>
public static class ShortcutPlistGenerator
{
    /// <summary>当前快捷指令模板版本，更新模板逻辑时递增</summary>
    public const int CurrentVersion = 1;

    /// <summary>
    /// 生成完整的 .shortcut XML plist
    /// </summary>
    public static string Generate(string shortcutName, string token, string serverUrl)
    {
        var endpoint = $"{serverUrl}/api/shortcuts/collect";
        var versionCheckUrl = $"{serverUrl}/api/shortcuts/version-check";
        var objectChar = "\uFFFC"; // Object Replacement Character，用于变量引用

        var actions = new XElement("array",
            // ── Action 0: Comment ──
            Action("is.workflow.actions.comment",
                Param("WFCommentActionText",
                    $"PrdAgent 收藏快捷指令 v{CurrentVersion}\n请勿修改下方 Config 字典中的值")),

            // ── Action 1: Dictionary "Config" ──
            // 模仿截图的模式：用户可见的配置，同时用于版本检查
            DictionaryAction(
                ("token", token),
                ("endpoint", endpoint),
                ("version", CurrentVersion.ToString()),
                ("update", versionCheckUrl),
                ("name", shortcutName)
            ),

            // ── Action 2: Set Variable "Config" ──
            SetVariableFromPreviousAction("Config", "词典"),

            // ── Action 3: Get Dictionary Value "version" from Config ──
            GetDictionaryValue("version", "Config"),

            // ── Action 4: Set Variable "LocalVersion" ──
            SetVariableFromPreviousAction("LocalVersion", "词典值"),

            // ── Action 5: Get Dictionary Value "update" from Config ──
            GetDictionaryValue("update", "Config"),

            // ── Action 6: Get Contents of URL (version check) ──
            SimpleGetUrl(),

            // ── Action 7: Set Variable "UpdateInfo" ──
            SetVariableFromPreviousAction("UpdateInfo", "URL 的内容"),

            // ── Action 8: Get Dictionary Value "version" from UpdateInfo ──
            GetDictionaryValue("version", "UpdateInfo"),

            // ── Action 9: Set Variable "RemoteVersion" ──
            SetVariableFromPreviousAction("RemoteVersion", "词典值"),

            // ── Action 10: If RemoteVersion > LocalVersion ──
            IfNumberGreaterThan("RemoteVersion", "LocalVersion"),

            // ── Action 11 (inside if): Get Dictionary Value "download" from UpdateInfo ──
            GetDictionaryValue("download", "UpdateInfo"),

            // ── Action 12 (inside if): Show Alert "有新版本" ──
            ShowAlert("快捷指令有新版本可用，点击「好」更新", "发现新版本"),

            // ── Action 13 (inside if): Open URL (download new version) ──
            OpenUrlFromPreviousAction(),

            // ── Action 14: End If ──
            EndIf(),

            // ── Action 15: Get Shortcut Input ──
            // 分享菜单传入的 URL/文本
            SetVariableAction("__INPUT__", ExtensionInputAttachment()),

            // ── Action 16: Get Contents of URL (POST collect) ──
            PostToCollect(endpoint, token, objectChar),

            // ── Action 17: Get Dictionary Value "message" ──
            GetDictionaryValueFromPreviousAction("message"),

            // ── Action 18: Show Notification ──
            ShowNotification(shortcutName)
        );

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
                        Key("WFWorkflowIconStartColor"), Int(463140863),  // 蓝紫色
                        Key("WFWorkflowIconGlyphNumber"), Int(59771)       // 书签图标
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

    #region Plist Primitives

    private static XElement Key(string name) => new("key", name);
    private static XElement Str(string value) => new("string", value);
    private static XElement Int(int value) => new("integer", value);

    private static XElement Param(string key, string value) =>
        new XElement("wrapper", Key(key), Str(value)); // wrapper stripped below

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

    /// <summary>纯文本（无变量引用）的 WFTextTokenString</summary>
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

    /// <summary>包含变量引用的 WFTextTokenString（变量占据整个字符串）</summary>
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

    /// <summary>变量引用的 WFTextTokenAttachment</summary>
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

    /// <summary>构建 WFDictionaryFieldValue（键值对列表）</summary>
    private static XElement[] DictionaryFieldValue(string key, params (string key, string value)[] items)
    {
        var fieldItems = new XElement("array");
        foreach (var (k, v) in items)
        {
            fieldItems.Add(new XElement("dict",
                Key("WFItemType"), Int(0), // 0 = text
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

    /// <summary>构建包含变量引用的字典项</summary>
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

    /// <summary>创建字典（Dictionary）动作</summary>
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

    /// <summary>Set Variable（从上一步输出）</summary>
    private static XElement SetVariableFromPreviousAction(string variableName, string outputName)
    {
        var paramsDict = new XElement("dict",
            Key("WFVariableName"), Str(variableName)
        );
        // 不需要显式 WFInput，默认使用上一个 action 的输出
        return new XElement("dict",
            Key("WFWorkflowActionIdentifier"), Str("is.workflow.actions.setvariable"),
            Key("WFWorkflowActionParameters"), paramsDict
        );
    }

    /// <summary>Set Variable（从指定 attachment）</summary>
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

    /// <summary>Get Dictionary Value（从命名变量）</summary>
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

    /// <summary>Get Dictionary Value（从上一步输出）</summary>
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

    /// <summary>简单 GET 请求（URL 来自上一步输出）</summary>
    private static XElement SimpleGetUrl()
    {
        return new XElement("dict",
            Key("WFWorkflowActionIdentifier"), Str("is.workflow.actions.downloadurl"),
            Key("WFWorkflowActionParameters"), new XElement("dict")
        );
    }

    /// <summary>If 数字大于（比较两个命名变量）</summary>
    private static XElement IfNumberGreaterThan(string variableA, string variableB)
    {
        var paramsDict = new XElement("dict",
            Key("WFCondition"), Int(2), // 2 = "is greater than"
            Key("WFControlFlowMode"), Int(0), // 0 = start of if
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

    /// <summary>End If</summary>
    private static XElement EndIf()
    {
        return new XElement("dict",
            Key("WFWorkflowActionIdentifier"), Str("is.workflow.actions.conditional"),
            Key("WFWorkflowActionParameters"), new XElement("dict",
                Key("WFControlFlowMode"), Int(2) // 2 = end
            )
        );
    }

    /// <summary>Show Alert</summary>
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

    /// <summary>Open URL（从上一步输出）</summary>
    private static XElement OpenUrlFromPreviousAction()
    {
        return new XElement("dict",
            Key("WFWorkflowActionIdentifier"), Str("is.workflow.actions.openurl"),
            Key("WFWorkflowActionParameters"), new XElement("dict")
        );
    }

    /// <summary>Show Notification</summary>
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

    /// <summary>POST 请求到收藏端点，带 Bearer token 和 JSON body</summary>
    private static XElement PostToCollect(string endpoint, string token, string objectChar)
    {
        var paramsDict = new XElement("dict",
            Key("WFURL"), Str(endpoint),
            Key("WFHTTPMethod"), Str("POST"),
            Key("WFHTTPBodyType"), Str("JSON"),
            Key("ShowHeaders"), new XElement("true")
        );

        // Headers: Authorization: Bearer scs-xxx
        foreach (var el in DictionaryFieldValue("WFHTTPHeaders",
            ("Authorization", $"Bearer {token}"),
            ("Content-Type", "application/json")))
        {
            paramsDict.Add(el);
        }

        // JSON Body: {"url": <ExtensionInput>, "text": <ExtensionInput>}
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
