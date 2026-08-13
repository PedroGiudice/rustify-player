# A classe do plugin e instanciada por reflexao pelo PluginManager do Tauri
# (`Class.forName("app.tauri.rustifyaudio.AudioPlugin")`), e os @InvokeArg sao
# populados pelo Jackson por reflexao de campo. Sem estes keeps o R8 remove
# tudo isso num build minificado.
-keep class app.tauri.rustifyaudio.AudioPlugin { *; }
-keep class app.tauri.rustifyaudio.AudioService { *; }
-keep class app.tauri.rustifyaudio.**Arg { *; }
-keep class app.tauri.rustifyaudio.**Args { *; }
