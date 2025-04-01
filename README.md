
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
- Node.js v18.0.0 أو أحدث  
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
const { Manager, Constants } = require('royal-lava');
const { Client, GatewayIntentBits, Partials, Events } = require('discord.js'); 

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
});

const nodes = [
    {
        host: 'localhost',
        port: 2333,
        password: 'youshallnotpass',
        identifier: 'Main Node',
        secure: false,
        resumeKey: `royal-lava-example-${process.pid}`,
        resumeTimeout: 60,
        retryAmount: 3,
        retryDelay: 500,
    },
];

client.lavalink = new Manager({
    nodes: nodes,
    userId: null,
    send: (guildId, payload) => {
        const guild = client.guilds.cache.get(guildId);
        if (guild?.shard?.ws?.readyState === 1) {
            guild.shard.send(payload);
        }
    },
    playerOptions: {
        initialVolume: 80,
        selfDeaf: true,
    },
});

client.once(Events.ClientReady, () => {
    console.log(`تم تسجيل الدخول باسم ${client.user.tag}!`);
    client.lavalink.userId = client.user.id;
});

client.on(Events.InteractionCreate, async interaction => {
    if (!interaction.isChatInputCommand() || !interaction.guildId) return;

    const { commandName } = interaction;

    if (commandName === 'play') {
        await interaction.deferReply();
        const query = interaction.options.getString('query', true);
        const memberChannel = interaction.member?.voice?.channel;

        if (!memberChannel) {
            return interaction.editReply({ content: 'يجب أن تكون في قناة صوتية لتشغيل الموسيقى!' });
        }

        let player = client.lavalink.getPlayer(interaction.guildId);
        if (!player) {
            player = client.lavalink.createPlayer(interaction.guildId);
            player.connect(memberChannel.id);
        }

        try {
            const searchResult = await client.lavalink.loadTracks(query);
            if (!searchResult.data?.length) {
                return interaction.editReply({ content: 'لم يتم العثور على نتائج.' });
            }

            const track = searchResult.data[0];
            player.queue.add(track);
            await interaction.editReply({ content: `تمت إضافة **${track.info.title}** إلى القائمة.` });

            if (!player.playing) {
                await player.play();
            }
        } catch (error) {
            console.error('[خطأ في التشغيل]', error);
            await interaction.editReply({ content: `حدث خطأ: ${error.message}` });
        }
    }
});

client.login('TOKEN');
```

---

## 🎉 الأحداث المدعومة  

```js
client.lavalink.on(Constants.CLIENT_EVENT_TYPES.NODE_CONNECT, node => {
    console.log(`[Node] متصل: ${node.identifier}`);
});

client.lavalink.on(Constants.CLIENT_EVENT_TYPES.TRACK_START, (player, track) => {
    console.log(`[Track] بدء تشغيل: ${track.info.title}`);
});

client.lavalink.on(Constants.CLIENT_EVENT_TYPES.TRACK_END, (player, track, payload) => {
    console.log(`[Track] انتهى التشغيل: ${track.info.title}`);
});
```

---

## 📝 ملاحظات  
- مكتبة **Royal-Lava** تركز على الأداء العالي والاستقرار.  
- يتم تحديثها باستمرار لدعم أحدث إصدارات Lavalink و Discord.js.  
