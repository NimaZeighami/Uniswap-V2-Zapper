# ⚡ Gas Speed Quick Reference

## 🚀 Current Setting: INSTANT (Ultra Fast!)

Your bot is now configured for **INSTANT** confirmations - the fastest possible!

---

## 🎮 How to Change Speed

### Edit `.env` file:

```bash
# Choose ONE of these:
GAS_SPEED=instant    # ⚡ Ultra Fast (< 1 min) - CURRENT SETTING
GAS_SPEED=fast       # 🚀 Fast (1-2 min)
GAS_SPEED=standard   # ⏱️  Medium (3-5 min)
GAS_SPEED=safe       # 🐢 Slow but cheap (10+ min)
```

**Then restart the bot:**
```bash
npm run zapbot
```

---

## 📊 Speed Comparison

| Setting | Confirmation Time | Gas Cost | When to Use |
|---------|------------------|----------|-------------|
| **instant** ⚡ | < 1 minute | ~20% more than fast | **Sniping new tokens, urgent trades** |
| **fast** 🚀 | 1-2 minutes | High | **Normal trading, competitive** |
| **standard** ⏱️ | 3-5 minutes | Medium | **Casual trades, less urgent** |
| **safe** 🐢 | 10+ minutes | Cheapest | **Testing, no rush** |

---

## 🎯 Advanced: Custom Speed Multiplier

For even MORE control, use the multiplier:

```bash
# Example: SUPER AGGRESSIVE
GAS_SPEED=instant
GAS_SPEED_MULTIPLIER=1.3      # 30% faster than instant!

# Example: Just a bit faster
GAS_SPEED=fast
GAS_SPEED_MULTIPLIER=1.1      # 10% faster than fast

# Example: Balanced
GAS_SPEED=standard
GAS_SPEED_MULTIPLIER=1.5      # Make standard as fast as instant
```

### Multiplier Guide:
- `1.0` = Normal speed for that tier
- `1.2` = 20% faster
- `1.5` = 50% faster
- `2.0` = 2x speed (very expensive!)

---

## 💡 Real-World Examples

### 1. Token Launch Snipe
```bash
GAS_SPEED=instant
GAS_SPEED_MULTIPLIER=1.5
MAX_GAS_PRICE_GWEI=500    # Allow higher gas
```
**Result:** Ultra aggressive, highest priority

### 2. Normal Trading
```bash
GAS_SPEED=fast
GAS_SPEED_MULTIPLIER=1.0
MAX_GAS_PRICE_GWEI=200
```
**Result:** Fast and reliable (default)

### 3. Cost-Conscious
```bash
GAS_SPEED=standard
GAS_SPEED_MULTIPLIER=1.0
MAX_GAS_PRICE_GWEI=100
```
**Result:** Balanced cost/speed

### 4. Testing Mode
```bash
GAS_SPEED=safe
GAS_SPEED_MULTIPLIER=1.0
MAX_GAS_PRICE_GWEI=50
```
**Result:** Cheapest possible

---

## 📈 How It Works

### Etherscan provides 3 speed tiers:

```
SafeGasPrice:     15 Gwei  (slow)
ProposeGasPrice:  18 Gwei  (standard)  
FastGasPrice:     22 Gwei  (fast)
```

### Your bot calculates:

```javascript
safe     = SafeGasPrice                    = 15 Gwei
standard = ProposeGasPrice                 = 18 Gwei
fast     = FastGasPrice                    = 22 Gwei
instant  = FastGasPrice * 1.2              = 26.4 Gwei
```

### Then applies multiplier:

```javascript
final = selected_speed * GAS_SPEED_MULTIPLIER
```

### Example with multiplier 1.5:

```javascript
instant * 1.5 = 26.4 * 1.5 = 39.6 Gwei
```

**This gets you in the NEXT block!**

---

## 🛡️ Safety Features

### 1. Maximum Gas Cap
```bash
MAX_GAS_PRICE_GWEI=200
```
Even with `instant` + high multiplier, you won't pay more than this cap.

### 2. Minimum Priority Fee
```bash
PRIORITY_FEE_GWEI=2.0
```
Ensures minimum priority even in low gas periods.

### 3. Auto-Correction
If priority fee > max fee, bot auto-corrects to prevent errors.

---

## 🔍 What You'll See in Logs

### With INSTANT speed:
```bash
[INFO] Gas from Etherscan V2 [Instant]: Max 26.40 Gwei, Priority 4.50 Gwei (Base: 21.90)
```

### With multiplier 1.5:
```bash
[INFO] Gas from Etherscan V2 [Instant x1.5]: Max 39.60 Gwei, Priority 17.70 Gwei (Base: 21.90)
```

### With FAST speed:
```bash
[INFO] Gas from Etherscan V2 [Fast]: Max 22.00 Gwei, Priority 0.10 Gwei (Base: 21.90)
```

---

## ⚙️ Full Configuration Example

```bash
# Ultra Fast Setup (Your Current Setting!)
GAS_SPEED=instant
GAS_SPEED_MULTIPLIER=1.0
PRIORITY_FEE_GWEI=2.0
MAX_GAS_PRICE_GWEI=200.0
```

**Explanation:**
- `GAS_SPEED=instant` → Use Fast * 1.2
- `GAS_SPEED_MULTIPLIER=1.0` → No extra boost
- `PRIORITY_FEE_GWEI=2.0` → Minimum 2 Gwei priority
- `MAX_GAS_PRICE_GWEI=200.0` → Cap at 200 Gwei max

---

## 🎯 Recommended Settings

### For Most Users:
```bash
GAS_SPEED=instant
GAS_SPEED_MULTIPLIER=1.0
```

### For Token Sniping:
```bash
GAS_SPEED=instant
GAS_SPEED_MULTIPLIER=1.3
MAX_GAS_PRICE_GWEI=500
```

### For Cost Saving:
```bash
GAS_SPEED=standard
GAS_SPEED_MULTIPLIER=1.0
MAX_GAS_PRICE_GWEI=100
```

---

## 📝 Quick Checklist

To change gas speed:

- [ ] Open `.env` file
- [ ] Find `GAS_SPEED=` line
- [ ] Change to: `safe`, `standard`, `fast`, or `instant`
- [ ] (Optional) Adjust `GAS_SPEED_MULTIPLIER=`
- [ ] Save file
- [ ] Restart bot: `npm run zapbot`
- [ ] Check logs for confirmation

---

## 🔥 Pro Tips

1. **For new token launches:** Use `instant` + high multiplier
2. **For regular trades:** Use `instant` (current setting)
3. **For low priority:** Use `standard` or `safe`
4. **During network congestion:** Increase multiplier
5. **During quiet times:** Decrease to `standard`

---

## ❓ FAQ

**Q: What's the difference between instant and fast?**
A: Instant = Fast * 1.2 (20% higher gas for faster confirmation)

**Q: Can I go faster than instant?**
A: Yes! Use `GAS_SPEED_MULTIPLIER=1.5` or higher

**Q: Will I always pay the max gas?**
A: No! The bot calculates based on network conditions. MAX is just a safety cap.

**Q: What if gas is really high?**
A: Your `MAX_GAS_PRICE_GWEI` cap protects you from overpaying

**Q: Do I need to restart after changing?**
A: Yes! The bot reads `.env` only on startup

---

## 🚀 You're All Set!

Your bot is configured for **INSTANT** speed - the fastest possible!

Just save `.env` and run:
```bash
npm run zapbot
```

Happy zapping! ⚡

