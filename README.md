
# Royal-Lava <img src="https://cdn.discordapp.com/avatars/1348283470371094619/6fa8ec5e19ce5fbcc65b690a3a42e24d.webp?size=40" align="right" alt="Lavalink Logo"/>

![alt text](https://img.shields.io/npm/v/royal-lava?style=for-the-badge&logo=npm)  
![alt text](https://img.shields.io/npm/dt/royal-lava?style=for-the-badge&logo=npm)  
![alt text](https://cdn.discordapp.com/avatars/1348283470371094619/6fa8ec5e19ce5fbcc65b690a3a42e24d.webp?size=4096)  

**Royal-Lava** هو أول مكتبة Lavalink v4 مبرمجة من قبل مبرمج عربي من العراق،  
وهي مكتبة قوية ومتطورة تتيح لك بناء بوتات موسيقى متقدمة لديسكورد، مع التركيز على الاستقرار وإدارة العقد المتعددة واستئناف الجلسات ونظام قائمة تشغيل قوي.

---

## ✨ المميزات  

🚀 **دعم Lavalink v4 بالكامل**  
متوافقة مع واجهات REST و WebSocket الخاصة بـ Lavalink v4.

🌐 **إدارة متعددة للعقد**  
- الاتصال بعدة عقد Lavalink وإدارتها في وقت واحد.  
- اختيار العقدة الأفضل تلقائيًا بناءً على الأداء (المعالج، الذاكرة، عدد المشغلات).  
- إضافة وإزالة العقد أثناء التشغيل.  

🔁 **إعادة الاتصال القوية**  
- إعادة الاتصال تلقائيًا في حالة إغلاق WebSocket غير المتوقع.  
- استراتيجيات متقدمة للحد من عمليات إعادة الاتصال العشوائية.  
- عدد محاولات إعادة الاتصال قابل للتخصيص.  

🔄 **استئناف الجلسات**  
- استغلال ميزة استئناف الجلسات في Lavalink v4 لاستعادة الحالة بسرعة بعد انقطاع قصير.  
- خيارات قابلة للتخصيص لمفتاح الاستئناف وفترة المهلة.  

🎶 **تحكم متقدم في المشغل**  
- `play()`: تشغيل المسارات مع خيارات متعددة (توقيت البدء/الانتهاء، الإيقاف المؤقت، الاستبدال).  
- `stop()`: إيقاف التشغيل وإمكانية مسح القائمة.  
- `pause() / resume()`: إيقاف أو استئناف التشغيل.  
- `skip()`: تخطي المسار الحالي.  
- `seek()`: الانتقال إلى نقطة معينة في المسار.  
- `setVolume()`: ضبط مستوى الصوت بين 0-1000.  
- `setLoop()`: تعيين وضع التكرار (لا شيء، مسار، قائمة).  

🇶 **نظام قائمة تشغيل متطور**  
- إضافة مسار واحد أو متعدد إلى القائمة.  
- إدراج مسارات في مواقع معينة.  
- استرجاع المسار التالي تلقائيًا وإدارة التكرار.  
- إزالة المسارات بواسطة الفهرس أو الكائن.  
- مسح القائمة بالكامل.  
- خلط ترتيب المسارات.  
- تتبع المسارات السابقة كـ history.  

🔗 **تكامل سلس مع Discord**  
- متوافق مع مكتبات Discord مثل discord.js و eris.  
- يتطلب توفير دالة لإرسال حزم الصوت إلى بوابة Discord.  
- يدير حالة اتصال الصوت تلقائيًا.  

✈️ **نقل المشغل بين العقد**  
- `player.moveToNode(newNode)`: نقل مشغل نشط من عقدة إلى أخرى بدون انقطاع، مفيد لصيانة العقد.  

🔥 **نظام أحداث قوي**  
- يصدر مجموعة واسعة من الأحداث لمراقبة العمليات وتنفيذ المنطق المخصص.  

📡 **تجريد واجهة REST**  
- يوفر طرقًا نظيفة للتفاعل مع REST API الخاص بـ Lavalink.  
- يشمل آليات إعادة المحاولة عند حدوث مهلات.  

---

## 📋 المتطلبات  
- Node.js v20.0.0 أو أحدث  
- NPM أو Yarn  
- خادم Lavalink v4 قيد التشغيل  

## 🔧 التثبيت  

```bash
npm install royal-lava
# أو
yarn add royal-lava
```

**تحتاج أيضًا إلى مكتبة Discord (مثل discord.js) وحزمة ws.**  

```bash
npm install discord.js ws
# أو
yarn add discord.js ws
```

---

## 🚀 مثال للاستخدام الأساسي مع Discord.js  

```js
// استيراد المكتبات اللازمة
const { Manager, Constants } = require('royal-lava');
const { Client, GatewayIntentBits, Partials, Events } = require('discord.js'); // استخدم discord.js v14+

// --- إعداد عميل ديسكورد ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages, // أضفها إذا كانت مطلوبة للأوامر
        GatewayIntentBits.MessageContent, // أضفها إذا كانت مطلوبة للأوامر النصية (prefix)
    ],
    partials: [Partials.Channel], // قد تكون مطلوبة للتفاعل في الرسائل الخاصة، تحقق من احتياجاتك
});

// --- إعدادات سيرفرات Lavalink ---
const nodes = [
    {
        host: 'localhost',         // عنوان سيرفر Lavalink الخاص بك
        port: 2333,                // منفذ WebSocket لسيرفر Lavalink الخاص بك
        password: 'youshallnotpass', // كلمة مرور سيرفر Lavalink الخاص بك
        identifier: 'Main Node',   // معرف اختياري للسيرفر
        secure: false,             // اجعلها true لاتصالات WSS الآمنة
        resumeKey: `royal-lava-example-${process.pid}`, // مثال لمفتاح استئناف فريد
        resumeTimeout: 60,        // مهلة الاستئناف بالثواني
        // اختياري: إعدادات إعادة المحاولة لطلبات REST (مختلفة عن إعادة اتصال WS)
        retryAmount: 3,            // عدد محاولات إعادة طلب REST
        // retryDelay: 500,      // تأخير أولي بالمللي ثانية لإعادة طلبات REST (ليس في الكود الحالي لكن يمكن إضافته لـ Rest.js)
    },
    // أضف المزيد من السيرفرات هنا إذا كنت تشغل عدة نسخ من Lavalink
];

// --- إنشاء مدير Royal-Lava ---
client.lavalink = new Manager({
    // يمكنك تمرير إعدادات السيرفرات هنا، ولكن addNode بعد الإنشاء هو الأفضل الآن
    nodes: [], // يبدأ فارغًا ويتم الإضافة لاحقًا أو مباشرة بـ addNode
    userId: null, // سيتم تعيينه في حدث 'ready' للعميل
    send: (guildId, payload) => {
        // دالة خاصة بك لإرسال البيانات الخام (payloads) لبوابة ديسكورد
        const guild = client.guilds.cache.get(guildId);
        // استخدم خاصية 'ws' في discord.js v14+ للشاردنج الداخلي أو عدل حسب الحاجة
        if (guild?.shard?.ws?.readyState === 1 /* WebSocket.OPEN */ ) {
             guild.shard.send(payload);
         } else if (client.ws?.shards?.get(guild?.shardId)?.ws?.readyState === 1) {
            // حل بديل في حالة الشارد الواحد أو إعداد مختلف
            client.ws.shards.get(guild.shardId)?.send(payload);
         } else {
             // console.warn(`[Lavalink SEND] تعذر العثور على WS نشط للشارد للسيرفر ${guildId}`);
         }
    },
    playerOptions: {
        // إعدادات افتراضية للمشغلات التي يتم إنشاؤها بواسطة هذا المدير
        initialVolume: 80,
        selfDeaf: true, // يفضل جعل البوت أصمًا في القنوات الصوتية
    },
});

// --- تهيئة السيرفرات بعد إنشاء المدير وتحديد هوية البوت ---
client.once(Events.ClientReady, () => {
    console.log(`تم تسجيل الدخول كـ ${client.user.tag}!`);
    // هام: قم بتعيين معرّف المستخدم (userId) للمدير بعد أن يصبح العميل جاهزًا
    client.lavalink.userId = client.user.id;
    console.log(`تم تهيئة مدير Lavalink لمعرف المستخدم: ${client.lavalink.userId}`);

    // قم بإضافة وتهيئة السيرفرات الآن بعد الحصول على userId
    nodes.forEach(nodeConfig => {
        try {
            client.lavalink.addNode(nodeConfig);
        } catch (err) {
            console.error(`فشل في إضافة السيرفر ${nodeConfig.identifier || nodeConfig.host}:`, err);
        }
    });
});


// --- مستمعو أحداث Royal-Lava ---
client.lavalink.on(Constants.CLIENT_EVENT_TYPES.NODE_CONNECT, node => {
    console.log(`[Lava Node Connect] السيرفر "${node.identifier}" متصل.`);
});

client.lavalink.on(Constants.CLIENT_EVENT_TYPES.NODE_READY, node => {
    console.log(`[Lava Node Ready] السيرفر "${node.identifier}" جاهز. Session ID: ${node.sessionId}`);
});

client.lavalink.on(Constants.CLIENT_EVENT_TYPES.NODE_ERROR, (node, error, context) => {
    console.error(`[Lava Node Error] خطأ في السيرفر "${node.identifier}": ${error.message}`, context || '');
});

client.lavalink.on(Constants.CLIENT_EVENT_TYPES.NODE_DISCONNECT, (node, code, reason) => {
    console.warn(`[Lava Node Disconnect] انقطع اتصال السيرفر "${node.identifier}". الرمز: ${code}, السبب: ${reason || 'لا يوجد سبب'}`);
});

client.lavalink.on(Constants.CLIENT_EVENT_TYPES.TRACK_START, (player, track) => {
    console.log(`[Lava Player ${player.guildId}] بدء تشغيل: ${track.info.title}`);
    // مثال: إرسال رسالة إلى قناة نصية في ديسكورد
    // const channel = client.channels.cache.get('YOUR_TEXT_CHANNEL_ID');
    // channel?.send(`💿 الآن يتم تشغيل: **${track.info.title}** بواسطة ${track.info.author}`);
});

client.lavalink.on(Constants.CLIENT_EVENT_TYPES.TRACK_END, (player, track, payload) => {
    console.log(`[Lava Player ${player.guildId}] انتهاء الأغنية. السبب: ${payload.reason}`);
    // track قد يكون null إذا تم إيقافه يدويًا أو فشل تحميل الأغنية التالية
});

client.lavalink.on(Constants.CLIENT_EVENT_TYPES.QUEUE_END, (player) => {
    console.log(`[Lava Player ${player.guildId}] انتهاء قائمة الانتظار.`);
    // مثال: مغادرة القناة الصوتية بعد فترة من عدم النشاط
    // setTimeout(() => {
    //     if (!player.playing && player.queue.isEmpty && player.connected) {
    //         player.disconnect();
    //         // إرسال رسالة مثل "تمت المغادرة بسبب عدم النشاط."
    //     }
    // }, 60 * 1000); // 60 ثانية
});

client.lavalink.on(Constants.CLIENT_EVENT_TYPES.PLAYER_WEBSOCKET_CLOSED, (player, payload) => {
     console.error(`[Lava Player ${player.guildId}] انغلق اتصال WebSocket مع ديسكورد! الرمز: ${payload.code}`);
     // يمكنك التعامل مع رموز الإغلاق المحددة إذا لزم الأمر، مثلاً طلب إعادة الاتصال
 });

client.lavalink.on(Constants.CLIENT_EVENT_TYPES.DEBUG, (message, ...args) => {
    // console.debug("[Lava Debug]", message, ...args); // قم بإلغاء التعليق لعرض سجلات التصحيح المفصلة
});


// --- مستمعو أحداث عميل ديسكورد ---

// تمرير أحداث VOICE_STATE_UPDATE و VOICE_SERVER_UPDATE إلى royal-lava
client.on(Events.Raw, async (d) => {
    // تحقق من تهيئة المدير قبل معالجة الأحداث
     if (client.lavalink?.userId && ['VOICE_STATE_UPDATE', 'VOICE_SERVER_UPDATE'].includes(d.t)) {
        // تحتاج لتمرير d.d (بيانات الحدث) للمُعالج
        if (d.t === 'VOICE_STATE_UPDATE') {
            try {
                await client.lavalink.handleVoiceStateUpdate(d.d);
             } catch (e) { console.error("[Lava Raw Handle] خطأ في معالجة VSU:", e.message); }
        } else if (d.t === 'VOICE_SERVER_UPDATE') {
             try {
                await client.lavalink.handleVoiceServerUpdate(d.d);
            } catch (e) { console.error("[Lava Raw Handle] خطأ في معالجة VServerU:", e.message); }
         }
     }
 });


// --- مثال على أمر /play (باستخدام تفاعلات Discord.js) ---
client.on(Events.InteractionCreate, async interaction => {
    if (!interaction.isChatInputCommand() || !interaction.guildId) return;

    const { commandName } = interaction;

    if (commandName === 'play') {
        await interaction.deferReply(); // تأجيل الرد لأن البحث قد يستغرق بعض الوقت
        const query = interaction.options.getString('query', true);
        const memberChannel = interaction.member?.voice?.channel;

        if (!memberChannel) {
            return interaction.editReply({ content: 'يجب أن تكون في قناة صوتية لتشغيل الموسيقى!' });
        }
        // تأكد من أن المدير جاهز ولديه userId
        if (!client.lavalink?.userId || client.lavalink.nodes.size === 0 || ![...client.lavalink.nodes.values()].some(n => n.connected)) {
             return interaction.editReply({ content: 'عفوًا، نظام الموسيقى غير جاهز حاليًا. يرجى المحاولة مرة أخرى لاحقًا.' });
        }

        // الحصول على المشغل أو إنشاؤه
        let player = client.lavalink.getPlayer(interaction.guildId);
        const botVoiceChannel = interaction.guild.members.me?.voice?.channel;

        // إذا لم يكن هناك مشغل أو تم تدميره
        if (!player || player.state === Constants.PLAYER_STATE.DESTROYED) {
            // إذا كان البوت موجودًا بالفعل في قناة أخرى، لا تسمح بمحاولة الاتصال
            if (botVoiceChannel && botVoiceChannel.id !== memberChannel.id) {
               return interaction.editReply({ content: `أنا أقوم بتشغيل الموسيقى بالفعل في ${botVoiceChannel.name}!` });
           }
            // إنشاء المشغل والاتصال
           try {
               player = client.lavalink.createPlayer(interaction.guildId);
               player.connect(memberChannel.id); // دع Royal-Lava تتولى إرسال OP 4
               // لا حاجة عادةً لانتظار أخطاء الاتصال هنا
           } catch (connectError) {
               console.error("فشل في إنشاء المشغل أو الاتصال:", connectError);
               await interaction.editReply({ content: `حدث خطأ أثناء محاولة الاتصال بالقناة الصوتية: ${connectError.message}` }).catch(() => {});
               if (player) await player.destroy().catch(() => {}); // حاول تنظيف المشغل الفاشل
               return;
           }
        } else if (player.voiceChannelId !== memberChannel.id) {
            // تحقق مما إذا كان المستخدم يحاول إعطاء أمر من قناة مختلفة
           return interaction.editReply({ content: `يجب أن تكون في نفس قناتي الصوتية الحالية (${botVoiceChannel?.name ?? 'غير معروف'}) لاستخدام الأوامر!` });
        }
        // إذا كان المستخدم والبوت في نفس القناة، أو تم الانضمام للتو

        try {
            const searchResult = await client.lavalink.loadTracks(query);

            // معالجة أخطاء التحميل
            if (searchResult.loadType === 'error') {
                console.error("Lavalink Load Error:", searchResult.data);
                throw new Error(`فشل تحميل الأغنية: ${searchResult.data?.message || 'سبب غير معروف'}`);
           }
            // معالجة عدم وجود نتائج
            if (searchResult.loadType === 'empty') {
                return interaction.editReply({ content: 'لم يتم العثور على أي نتائج لطلبك.' });
           }

           let trackToAdd;
           let replyMessage;

            // معالجة النتائج المختلفة
            if (searchResult.loadType === 'playlist') {
                player.queue.add(searchResult.data.tracks);
                replyMessage = `✅ تمت إضافة قائمة التشغيل **${searchResult.data.info.name}** (${searchResult.data.tracks.length} أغنية) إلى قائمة الانتظار.`;
            } else {
                // إما 'track' أو 'search'
                trackToAdd = searchResult.data?.[0] ?? searchResult.data;
                 if (!trackToAdd || !trackToAdd.info) {
                     console.error("Invalid track data received:", trackToAdd);
                    return interaction.editReply({ content: 'فشل الحصول على معلومات الأغنية من النتيجة.' });
                 }
                 player.queue.add(trackToAdd);
                 replyMessage = `✅ تمت إضافة **${trackToAdd.info.title}** إلى قائمة الانتظار.`;
             }


            await interaction.editReply({ content: replyMessage });

            // بدء التشغيل إذا لم يكن يعمل بالفعل أو متوقف مؤقتًا
           if (player.state !== Constants.PLAYER_STATE.PLAYING && player.state !== Constants.PLAYER_STATE.PAUSED) {
               await player.play();
           }

        } catch (error) {
            console.error('[Play Command Error]', error);
            // استخدام editReply بأمان حتى لو حدث خطأ بعد التأجيل
           await interaction.editReply({ content: `حدث خطأ: ${error.message}` }).catch(()=>{});
            // اختياري: تدمير المشغل إذا فشل الاتصال / التشغيل الأولي بشكل حرج
            // if (player && !player.connected && player.state !== Constants.PLAYER_STATE.PLAYING) {
           //     await player.destroy().catch(()=>{});
           // }
        }
    }
    // أضف المزيد من الأوامر هنا (تخطي، إيقاف مؤقت، إيقاف، عرض القائمة، حجم الصوت، تكرار، إلخ)
});

// --- تسجيل الدخول ---
client.login('YOUR_BOT_TOKEN'); // استبدل هذا بالتوكن الخاص ببوت ديسكورد الخاص بك
```

---

## 🎉 الأحداث المدعومة  

```js
 تصدر royal-lava أحداثًا متنوعة عبر كائن المدير (Manager). استخدم Constants.CLIENT_EVENT_TYPES لأسماء الأحداث:

أحداث السيرفر (Node):

NODE_CONNECT (node): يصدر عند إنشاء اتصال WebSocket للسيرفر بنجاح.
NODE_READY (node): يصدر عندما يبلغ السيرفر عن جاهزيته (يستلم معرّف الجلسة، يؤكد الاتصال/الاستئناف).
NODE_DISCONNECT (node, code, reason): يصدر عند إغلاق اتصال WebSocket للسيرفر.
NODE_ERROR (node, error, context): يصدر عند حدوث أخطاء WebSocket أو REST متعلقة بالسيرفر. قد يوفر context مزيدًا من التفاصيل (مثل العملية الفاشلة).
NODE_STATS (node, stats): يصدر بشكل دوري عند استلام إحصائيات السيرفر.

أحداث المشغل (Player):

PLAYER_CREATE (player): يصدر عند إنشاء كائن مشغل جديد.
PLAYER_DESTROY (player): يصدر عند تدمير كائن مشغل (محليًا).
PLAYER_MOVE (player, oldNode, newNode): يصدر عند نقل مشغل بنجاح إلى سيرفر مختلف.
PLAYER_STATE_UPDATE (player, state): يصدر عندما يرسل Lavalink تحديثًا لحالة المشغل (الموضع، زمن الاستجابة ping، حالة الاتصال).
PLAYER_WEBSOCKET_CLOSED (player, payload): يصدر عند إغلاق اتصال WebSocket الصوتي لديسكورد للمشغل (كما تم الإبلاغ عنه بواسطة Lavalink).

أحداث الأغاني والقائمة (Track & Queue):

TRACK_START (player, track): يصدر عند بدء تشغيل أغنية.
TRACK_END (player, track, payload): يصدر عند انتهاء أغنية أو إيقافها أو استبدالها. يحتوي payload على السبب. قد يكون track فارغًا (null) إذا لم يكن متاحًا.
TRACK_EXCEPTION (player, track, error): يصدر عند حدوث خطأ أثناء تشغيل أغنية (مثل خطأ في فك التشفير). قد يكون track فارغًا.
TRACK_STUCK (player, track, thresholdMs): يصدر إذا علقت أغنية ولم تتقدم للمدة المحددة. قد يكون track فارغًا.
QUEUE_END (player): يصدر عند انتهاء قائمة الانتظار وعدم وجود وضع تكرار نشط يستمر في التشغيل.

أحداث أخرى:

DEBUG (message, ...optionalArgs): يصدر للحصول على معلومات تصحيح الأخطاء الداخلية.
```

---

## 📝 ملاحظات  
- مكتبة **Royal-Lava** تركز على الأداء العالي والاستقرار.  
- يتم تحديثها باستمرار لدعم أحدث إصدارات Lavalink و Discord.js.  
