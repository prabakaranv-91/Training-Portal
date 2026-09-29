"""
Nutrition log: parse free-text food intake, look up nutrition, keep history.

- Parsing: "i had 2 idli with 1 cut sambar, 1 scoop iso whey and 4 whole eggs"
  -> [(2, piece, idli), (1, cup, sambar), (1, scoop, iso whey), (4, piece, egg)]
- Lookup order per item:
    1. Built-in table of common (mostly Indian / sports) foods with realistic
       serving weights (idli, sambar, dosa, whey scoop, egg ...).
    2. USDA FoodData Central (free API; key via env USDA_FDC_API_KEY,
       defaults to the public DEMO_KEY).
    3. Open Food Facts (free, no key).
- History is stored as JSON at ~/.training_lab/nutrition_log.json
  (override with env NUTRITION_DATA_DIR).
"""

from __future__ import annotations

import datetime as dt
import difflib
import json
import logging
import os
import re
import threading
import uuid
from pathlib import Path
from typing import Any

import requests

logger = logging.getLogger("nutrition.service")

NUTRIENTS = ("kcal", "protein", "carbs", "fat", "fiber", "sugar", "sodium")

DATA_DIR = Path(os.environ.get("NUTRITION_DATA_DIR") or Path.home() / ".training_lab")
LOG_FILE = DATA_DIR / "nutrition_log.json"
CACHE_FILE = DATA_DIR / "food_lookup_cache.json"
_LOCK = threading.Lock()

USDA_KEY = os.environ.get("USDA_FDC_API_KEY", "DEMO_KEY")
USDA_URL = "https://api.nal.usda.gov/fdc/v1/foods/search"
OFF_URL = "https://world.openfoodfacts.org/cgi/search.pl"
HTTP_HEADERS = {"User-Agent": "TrainingLab/1.0 (personal nutrition log)"}
_LOOKUP_CACHE: dict[str, dict[str, Any]] = {}

# ------------------------------------------------------------ food table
# Values per 100 g: kcal, protein, carbs, fat, fiber, sugar (g), sodium (mg).
# `units` = grams per unit; `default` = unit used when none is given.


def _f(aliases, kcal, p, c, fat, fib, sug, na, units, default="piece"):
    return {
        "aliases": aliases,
        "per100": dict(zip(NUTRIENTS, (kcal, p, c, fat, fib, sug, na))),
        "units": units,
        "default": default,
    }


FOODS: dict[str, dict[str, Any]] = {
    "Idli": _f(["idli", "idly", "iddli", "ildli", "ilddli"], 132, 4.3, 27, 0.6, 1.0, 0.3, 250, {"piece": 40}),
    "Plain dosa": _f(["dosa", "dosai", "plain dosa", "dose"], 168, 3.9, 29, 3.7, 1.0, 0.5, 300, {"piece": 80}),
    "Masala dosa": _f(["masala dosa"], 180, 3.8, 26, 7.0, 2.0, 1.0, 350, {"piece": 160}),
    "Uttapam": _f(["uttapam", "oothappam", "uthappam"], 160, 4.0, 26, 4.5, 1.5, 1.0, 300, {"piece": 120}),
    "Medu vada": _f(["vada", "vadai", "medu vada"], 290, 9.0, 30, 15, 3.0, 0.5, 350, {"piece": 50}),
    "Pongal": _f(["pongal", "ven pongal"], 150, 4.0, 20, 6.0, 1.0, 0.3, 300, {"cup": 200, "bowl": 250, "plate": 250}, "cup"),
    "Upma": _f(["upma", "uppuma"], 140, 3.5, 20, 5.0, 1.5, 1.0, 300, {"cup": 200, "bowl": 250, "plate": 250}, "cup"),
    "Poha": _f(["poha", "aval"], 130, 2.6, 23, 3.5, 1.3, 1.5, 250, {"cup": 150, "bowl": 200, "plate": 250}, "cup"),
    "Sambar": _f(["sambar", "sambhar", "sambaar"], 55, 2.6, 7.5, 1.7, 2.0, 1.5, 350, {"cup": 150, "bowl": 200}, "cup"),
    "Rasam": _f(["rasam"], 30, 1.0, 4.0, 1.0, 0.5, 1.0, 400, {"cup": 150, "bowl": 200}, "cup"),
    "Coconut chutney": _f(["chutney", "coconut chutney", "chatni"], 190, 2.5, 8.0, 17, 4.0, 2.0, 300, {"cup": 60, "bowl": 80, "tbsp": 15}, "tbsp"),
    "Chapati": _f(["chapati", "chapathi", "roti", "phulka", "chappathi"], 300, 8.5, 46, 9.0, 5.0, 1.0, 300, {"piece": 40}),
    "Parotta": _f(["parotta", "paratha", "porotta"], 330, 7.0, 45, 13, 2.0, 1.5, 400, {"piece": 80}),
    "White rice (cooked)": _f(["rice", "white rice", "steamed rice", "boiled rice", "sadam"], 130, 2.7, 28, 0.3, 0.4, 0.1, 1, {"cup": 160, "bowl": 200, "plate": 250}, "cup"),
    "Brown rice (cooked)": _f(["brown rice"], 123, 2.7, 25.6, 1.0, 1.6, 0.2, 4, {"cup": 160, "bowl": 200, "plate": 250}, "cup"),
    "Curd rice": _f(["curd rice", "thayir sadam"], 115, 3.5, 17, 3.5, 0.4, 2.0, 250, {"cup": 200, "bowl": 250, "plate": 300}, "cup"),
    "Chicken biryani": _f(["biryani", "chicken biryani"], 170, 8.0, 22, 6.0, 1.0, 1.0, 400, {"cup": 200, "bowl": 250, "plate": 350}, "plate"),
    "Dal (cooked)": _f(["dal", "dhal", "paruppu", "lentil", "lentil curry"], 100, 5.0, 14, 2.5, 3.0, 1.0, 300, {"cup": 200, "bowl": 200}, "cup"),
    "Chickpeas (cooked)": _f(["chana", "chickpea", "channa", "sundal", "boiled chana"], 164, 8.9, 27, 2.6, 7.6, 4.8, 7, {"cup": 160, "bowl": 200}, "cup"),
    "Rajma (cooked)": _f(["rajma", "kidney bean"], 127, 8.7, 22.8, 0.5, 6.4, 0.3, 2, {"cup": 180, "bowl": 200}, "cup"),
    "Moong sprouts": _f(["sprout", "moong sprout", "sprouted moong"], 30, 3.0, 6.0, 0.2, 1.8, 4.1, 6, {"cup": 100, "bowl": 150}, "cup"),
    "Soya chunks (dry)": _f(["soya chunk", "soya", "soy chunk", "meal maker"], 345, 52, 33, 0.5, 13, 3.0, 20, {"cup": 50}, "cup"),
    "Curd / yogurt": _f(["curd", "yogurt", "yoghurt", "dahi", "thayir"], 61, 3.5, 4.7, 3.3, 0, 4.7, 46, {"cup": 245, "bowl": 200, "tbsp": 15}, "cup"),
    "Greek yogurt": _f(["greek yogurt", "greek yoghurt", "hung curd"], 97, 9.0, 3.9, 5.0, 0, 3.6, 35, {"cup": 200, "bowl": 200, "tbsp": 15}, "cup"),
    "Milk": _f(["milk", "toned milk"], 58, 3.2, 4.8, 3.0, 0, 4.8, 44, {"glass": 250, "cup": 200}, "glass"),
    "Whole egg": _f(["egg", "whole egg", "boiled egg", "egg boiled", "fried egg", "poached egg"], 143, 12.6, 0.7, 9.5, 0, 0.4, 142, {"piece": 50}),
    "Egg white": _f(["egg white", "white egg", "egg whites only"], 52, 10.9, 0.7, 0.2, 0, 0.7, 166, {"piece": 33}),
    "Omelette": _f(["omelette", "omelet", "omlet"], 154, 10.6, 0.6, 12, 0, 0.4, 300, {"piece": 110}),
    "Whey isolate": _f(["iso whey", "whey isolate", "isolate", "iso"], 367, 83, 3.3, 1.0, 0, 1.0, 230, {"scoop": 30}, "scoop"),
    "Whey protein": _f(["whey", "whey protein", "protein powder", "protein shake"], 395, 79, 10, 5.0, 0, 5.0, 200, {"scoop": 30}, "scoop"),
    "Chicken breast (cooked)": _f(["chicken breast", "grilled chicken", "chicken"], 165, 31, 0, 3.6, 0, 0, 74, {"piece": 120, "cup": 140}, "serving"),
    "Chicken curry": _f(["chicken curry", "chicken gravy", "chicken masala"], 140, 13, 4.0, 8.0, 1.0, 1.5, 400, {"cup": 200, "bowl": 200}, "cup"),
    "Fish curry": _f(["fish curry", "meen kuzhambu"], 120, 12, 4.0, 6.0, 1.0, 1.0, 400, {"cup": 200, "bowl": 200}, "cup"),
    "Fish (grilled)": _f(["fish", "grilled fish", "fish fry"], 180, 22, 2.0, 9.0, 0, 0, 200, {"piece": 100}, "serving"),
    "Paneer": _f(["paneer", "cottage cheese"], 265, 18.3, 1.2, 20.8, 0, 1.2, 18, {"piece": 25, "cup": 150}, "serving"),
    "Tofu": _f(["tofu"], 144, 17, 3.0, 8.7, 2.3, 0.6, 14, {"piece": 85, "cup": 250}, "serving"),
    "Banana": _f(["banana", "plantain fruit"], 89, 1.1, 22.8, 0.3, 2.6, 12.2, 1, {"piece": 118}),
    "Apple": _f(["apple"], 52, 0.3, 13.8, 0.2, 2.4, 10.4, 1, {"piece": 180}),
    "Orange": _f(["orange"], 47, 0.9, 11.8, 0.1, 2.4, 9.4, 0, {"piece": 130}),
    "Dates": _f(["date", "khajur", "medjool"], 280, 2.5, 75, 0.4, 8.0, 63, 2, {"piece": 10}),
    "Oats (dry)": _f(["oat", "oatmeal", "rolled oat"], 389, 16.9, 66, 6.9, 10.6, 1.0, 2, {"cup": 80, "tbsp": 10, "bowl": 50}, "cup"),
    "White bread": _f(["bread", "white bread"], 265, 9.0, 49, 3.2, 2.7, 5.0, 490, {"slice": 25, "piece": 25}, "slice"),
    "Brown bread": _f(["brown bread", "wheat bread", "whole wheat bread", "multigrain bread"], 247, 13, 41, 3.4, 7.0, 6.0, 450, {"slice": 28, "piece": 28}, "slice"),
    "Peanut butter": _f(["peanut butter"], 588, 25, 20, 50, 6.0, 9.0, 430, {"tbsp": 16, "tsp": 5}, "tbsp"),
    "Peanuts": _f(["peanut", "groundnut", "kadalai"], 567, 25.8, 16, 49, 8.5, 4.7, 18, {"handful": 30, "cup": 146}, "handful"),
    "Almonds": _f(["almond", "badam"], 579, 21, 22, 50, 12.5, 4.4, 1, {"piece": 1.2, "handful": 28}),
    "Potato (boiled)": _f(["potato", "aloo"], 87, 1.9, 20, 0.1, 1.8, 0.9, 5, {"piece": 150, "cup": 150}),
    "Sweet potato": _f(["sweet potato", "sakkaravalli"], 90, 2.0, 20.7, 0.2, 3.3, 6.5, 36, {"piece": 130, "cup": 200}),
    "Vegetable salad": _f(["salad", "vegetable salad", "veg salad"], 20, 1.0, 4.0, 0.2, 1.8, 2.0, 10, {"cup": 100, "bowl": 150, "plate": 200}, "bowl"),
    "Carrot": _f(["carrot", "gajar"], 41, 0.9, 9.6, 0.2, 2.8, 4.7, 69, {"piece": 60, "cup": 120}),
    "Cucumber": _f(["cucumber", "kheera", "vellarikkai"], 15, 0.7, 3.6, 0.1, 0.5, 1.7, 2, {"piece": 200, "cup": 120, "slice": 10}),
    "Tomato": _f(["tomato", "tamatar", "thakkali"], 18, 0.9, 3.9, 0.2, 1.2, 2.6, 5, {"piece": 120, "cup": 180, "slice": 20}),
    "Onion": _f(["onion", "pyaz", "vengayam"], 40, 1.1, 9.3, 0.1, 1.7, 4.2, 4, {"piece": 110, "cup": 160, "slice": 10}),
    "Beetroot": _f(["beetroot", "beet", "chukandar"], 43, 1.6, 10, 0.2, 2.8, 6.8, 78, {"piece": 80, "cup": 135}),
    "Vegetable curry": _f(["poriyal", "vegetable curry", "veg curry", "sabzi", "subzi", "kootu"], 90, 2.5, 9.0, 5.0, 3.0, 3.0, 300, {"cup": 150, "bowl": 150}, "cup"),
    "Coffee (milk + sugar)": _f(["coffee", "filter coffee", "cappuccino", "latte"], 45, 1.5, 6.5, 1.5, 0, 6.0, 20, {"cup": 150, "glass": 200}, "cup"),
    "Black coffee": _f(["black coffee", "americano", "espresso"], 2, 0.1, 0, 0, 0, 0, 2, {"cup": 200}, "cup"),
    "Tea (milk + sugar)": _f(["tea", "chai", "milk tea", "masala chai"], 40, 1.2, 6.0, 1.2, 0, 6.0, 15, {"cup": 150, "glass": 200}, "cup"),
    "Green tea": _f(["green tea", "black tea"], 1, 0, 0.2, 0, 0, 0, 1, {"cup": 200}, "cup"),
    "Sugar": _f(["sugar"], 387, 0, 100, 0, 0, 100, 1, {"tsp": 4, "tbsp": 12}, "tsp"),
    "Ghee": _f(["ghee"], 900, 0, 0, 100, 0, 0, 2, {"tsp": 5, "tbsp": 14}, "tsp"),
    "Butter": _f(["butter"], 717, 0.9, 0.1, 81, 0, 0.1, 640, {"tsp": 5, "tbsp": 14}, "tsp"),
    "Honey": _f(["honey"], 304, 0.3, 82, 0, 0.2, 82, 4, {"tsp": 7, "tbsp": 21}, "tsp"),
    "Coconut water": _f(["coconut water", "tender coconut", "elaneer"], 19, 0.7, 3.7, 0.2, 1.1, 2.6, 105, {"glass": 240, "piece": 300}, "glass"),
    "Buttermilk": _f(["buttermilk", "chaas", "moru"], 25, 1.5, 2.5, 1.0, 0, 2.5, 150, {"glass": 250, "cup": 200}, "glass"),
    "Ragi (finger millet)": _f(["ragi", "ragi malt", "ragi kanji", "ragi mudde"], 100, 2.5, 21, 0.6, 2.5, 0.5, 5, {"cup": 200, "glass": 250, "bowl": 250}, "cup"),
    # --- Indian dishes (approx. home/restaurant recipes, IFCT-style values)
    "Veg sandwich": _f(["sandwich", "veg sandwich", "vegetable sandwich", "bread sandwich"], 200, 5.5, 28, 7.5, 3.0, 4.0, 450, {"piece": 150}),
    "Paneer sandwich": _f(["paneer sandwich", "paneer grilled sandwich"], 240, 10, 25, 11, 2.5, 3.5, 450, {"piece": 170}),
    "Chicken sandwich": _f(["chicken sandwich"], 230, 14, 24, 8.5, 2.0, 3.5, 500, {"piece": 170}),
    "Egg sandwich": _f(["egg sandwich", "omelette sandwich"], 220, 10, 23, 10, 2.0, 3.0, 450, {"piece": 160}),
    "Cheese sandwich": _f(["cheese sandwich", "grilled cheese", "cheese toast"], 300, 11, 28, 16, 2.0, 4.0, 700, {"piece": 130}),
    "Paneer butter masala": _f(["paneer butter masala", "paneer makhani", "shahi paneer", "paneer masala", "paneer curry", "paneer gravy"], 230, 8.0, 8.0, 19, 1.5, 4.0, 400, {"cup": 200, "bowl": 200}, "cup"),
    "Palak paneer": _f(["palak paneer", "saag paneer"], 150, 7.0, 6.0, 11, 2.0, 2.0, 350, {"cup": 200, "bowl": 200}, "cup"),
    "Matar / kadai paneer": _f(["matar paneer", "mutter paneer", "kadai paneer", "kadhai paneer"], 160, 7.0, 9.0, 11, 3.0, 3.0, 380, {"cup": 200, "bowl": 200}, "cup"),
    "Paneer tikka": _f(["paneer tikka"], 250, 16, 6.0, 18, 1.0, 2.0, 400, {"piece": 30, "plate": 200}, "serving"),
    "Paneer bhurji": _f(["paneer bhurji", "paneer burji"], 220, 13, 5.0, 16, 1.0, 2.0, 350, {"cup": 150, "bowl": 150}, "cup"),
    "Paneer roll": _f(["paneer roll", "paneer wrap", "paneer kathi roll", "paneer frankie"], 260, 10, 28, 12, 2.0, 3.0, 500, {"piece": 180}),
    "Paneer paratha": _f(["paneer paratha"], 260, 9.0, 30, 12, 3.0, 1.5, 400, {"piece": 120}),
    "Aloo paratha": _f(["aloo paratha", "alu paratha", "potato paratha", "gobi paratha", "stuffed paratha"], 230, 5.0, 32, 9.0, 3.0, 1.5, 400, {"piece": 130}),
    "Naan": _f(["naan", "nan", "kulcha", "tandoori roti"], 290, 9.0, 50, 5.5, 2.0, 3.0, 450, {"piece": 90}),
    "Butter naan": _f(["butter naan", "garlic naan", "cheese naan"], 320, 8.5, 48, 10, 2.0, 3.0, 500, {"piece": 100}),
    "Puri": _f(["puri", "poori"], 330, 6.0, 40, 17, 2.0, 1.0, 300, {"piece": 30}),
    "Bhatura": _f(["bhatura", "bhature"], 330, 7.0, 42, 15, 1.5, 2.0, 400, {"piece": 80}),
    "Thepla": _f(["thepla", "methi thepla"], 290, 8.0, 40, 11, 5.0, 1.0, 350, {"piece": 40}),
    "Appam": _f(["appam", "aappam"], 150, 2.5, 30, 2.0, 1.0, 2.0, 200, {"piece": 60}),
    "Idiyappam": _f(["idiyappam", "string hopper", "noolappam"], 130, 2.0, 28, 0.5, 1.0, 0.2, 150, {"piece": 40}),
    "Puttu": _f(["puttu"], 160, 3.0, 33, 1.5, 2.0, 0.5, 150, {"cup": 150, "piece": 150}, "cup"),
    "Pesarattu": _f(["pesarattu", "moong dal dosa", "green gram dosa"], 170, 8.0, 24, 5.0, 4.0, 1.0, 300, {"piece": 100}),
    "Rava dosa": _f(["rava dosa", "rava dosai", "onion rava dosa"], 190, 4.0, 28, 7.0, 1.5, 1.0, 350, {"piece": 100}),
    "Egg dosa": _f(["egg dosa", "egg dosai", "muttai dosai"], 190, 7.5, 22, 8.0, 1.0, 0.5, 350, {"piece": 120}),
    "Ghee roast dosa": _f(["ghee roast", "ghee dosa", "ghee roast dosa", "paper roast"], 230, 4.0, 30, 10, 1.0, 0.5, 300, {"piece": 110}),
    "Kothu parotta": _f(["kothu parotta", "kottu parotta", "kothu"], 230, 8.0, 25, 11, 1.5, 1.5, 500, {"plate": 300, "cup": 200}, "plate"),
    "Lemon / tomato rice": _f(["lemon rice", "tomato rice", "chitranna", "coconut rice"], 170, 3.0, 30, 4.5, 1.0, 1.0, 350, {"cup": 200, "bowl": 250, "plate": 300}, "cup"),
    "Tamarind rice": _f(["tamarind rice", "puliyodarai", "puliyogare", "puli sadam"], 180, 3.0, 30, 5.5, 1.5, 2.0, 400, {"cup": 200, "bowl": 250, "plate": 300}, "cup"),
    "Jeera rice / pulao": _f(["jeera rice", "pulao", "pulav", "veg pulao", "ghee rice"], 155, 3.0, 26, 4.0, 1.5, 1.0, 300, {"cup": 200, "bowl": 250, "plate": 300}, "cup"),
    "Khichdi": _f(["khichdi", "khichri", "kichadi"], 120, 4.5, 20, 2.5, 2.0, 0.5, 300, {"cup": 200, "bowl": 250, "plate": 300}, "cup"),
    "Bisi bele bath": _f(["bisi bele bath", "bisibelebath", "sambar rice", "sambar sadam"], 140, 4.0, 22, 4.0, 2.5, 1.5, 400, {"cup": 200, "bowl": 250, "plate": 300}, "cup"),
    "Veg biryani": _f(["veg biryani", "vegetable biryani", "veg briyani"], 150, 3.5, 24, 4.5, 2.0, 1.5, 400, {"cup": 200, "bowl": 250, "plate": 300}, "plate"),
    "Mutton biryani": _f(["mutton biryani", "mutton briyani"], 190, 9.0, 21, 8.0, 1.0, 1.0, 450, {"cup": 200, "bowl": 250, "plate": 350}, "plate"),
    "Egg biryani": _f(["egg biryani", "egg briyani"], 170, 6.5, 23, 6.0, 1.0, 1.0, 400, {"cup": 200, "bowl": 250, "plate": 350}, "plate"),
    "Fried rice": _f(["fried rice", "veg fried rice", "chicken fried rice", "egg fried rice"], 170, 5.0, 25, 5.5, 1.0, 1.0, 500, {"cup": 200, "bowl": 250, "plate": 300}, "plate"),
    "Hakka noodles": _f(["noodle", "hakka noodle", "chowmein", "chow mein", "chicken noodle"], 170, 5.5, 25, 5.5, 1.5, 2.0, 550, {"cup": 200, "bowl": 250, "plate": 300}, "plate"),
    "Instant noodles (Maggi)": _f(["maggi", "instant noodle", "top ramen", "yippee"], 440, 9.0, 62, 17, 3.0, 2.0, 1300, {"piece": 70}),
    "Sabudana khichdi": _f(["sabudana", "sabudana khichdi", "javvarisi"], 200, 1.5, 35, 6.5, 1.0, 1.0, 250, {"cup": 200, "bowl": 200}, "cup"),
    "Sweet pongal": _f(["sweet pongal", "sakkarai pongal", "chakkara pongal"], 230, 3.0, 40, 7.0, 1.0, 22, 30, {"cup": 150, "bowl": 200}, "cup"),
    "Butter chicken": _f(["butter chicken", "chicken makhani", "chicken tikka masala"], 180, 13, 6.0, 12, 1.0, 3.0, 450, {"cup": 200, "bowl": 200}, "cup"),
    "Chicken tikka / tandoori": _f(["chicken tikka", "tandoori chicken", "chicken tandoori", "grilled chicken tikka"], 150, 22, 3.0, 5.5, 0.5, 1.0, 450, {"piece": 150, "plate": 250}, "serving"),
    "Chicken 65 / fry": _f(["chicken sixtyfive", "chicken fry", "chilli chicken", "pepper chicken", "fried chicken", "chicken lollipop"], 250, 18, 12, 14, 0.5, 2.0, 550, {"piece": 30, "plate": 200, "cup": 150}, "serving"),
    "Chicken shawarma": _f(["shawarma", "chicken shawarma", "chicken roll", "chicken wrap", "chicken frankie", "kathi roll"], 230, 13, 22, 10, 1.5, 2.5, 550, {"piece": 220}),
    "Mutton curry": _f(["mutton curry", "mutton gravy", "goat curry", "lamb curry", "mutton"], 180, 14, 4.0, 12, 1.0, 1.5, 450, {"cup": 200, "bowl": 200}, "cup"),
    "Egg curry": _f(["egg curry", "egg masala", "egg gravy", "muttai kuzhambu"], 150, 8.0, 5.0, 11, 1.0, 2.0, 400, {"cup": 200, "bowl": 200}, "cup"),
    "Egg bhurji": _f(["egg bhurji", "egg burji", "scrambled egg", "egg podimas"], 190, 11, 3.0, 15, 0.5, 1.0, 350, {"cup": 150, "plate": 150}, "cup"),
    "Prawn curry": _f(["prawn curry", "prawn masala", "shrimp curry", "eral"], 120, 13, 4.0, 6.0, 0.5, 1.0, 450, {"cup": 200, "bowl": 200}, "cup"),
    "Dal makhani": _f(["dal makhani", "dal makhni"], 150, 6.0, 14, 8.0, 4.0, 1.5, 350, {"cup": 200, "bowl": 200}, "cup"),
    "Chole masala": _f(["chole", "chana masala", "chole masala", "chole bhature gravy"], 150, 6.5, 20, 5.5, 6.0, 3.0, 400, {"cup": 200, "bowl": 200}, "cup"),
    "Aloo gobi / sabzi": _f(["aloo gobi", "aloo sabzi", "potato curry", "potato fry", "urulai", "aloo matar"], 110, 2.5, 13, 5.5, 3.0, 2.0, 350, {"cup": 150, "bowl": 150}, "cup"),
    "Avial": _f(["avial", "aviyal"], 110, 2.5, 9.0, 7.5, 3.0, 2.5, 250, {"cup": 150, "bowl": 150}, "cup"),
    "Veg kurma": _f(["kurma", "korma", "veg kurma", "veg korma", "navratan korma"], 130, 3.0, 10, 9.0, 2.5, 3.0, 350, {"cup": 150, "bowl": 200}, "cup"),
    "Kuzhambu": _f(["kuzhambu", "kara kuzhambu", "vatha kuzhambu", "mor kuzhambu", "kulambu"], 80, 1.5, 8.0, 5.0, 1.5, 2.0, 450, {"cup": 150, "bowl": 200}, "cup"),
    "Raita": _f(["raita", "pachadi", "thayir pachadi"], 70, 3.0, 5.0, 4.0, 0.5, 4.0, 200, {"cup": 150, "bowl": 150, "tbsp": 15}, "cup"),
    "Pickle": _f(["pickle", "achar", "oorugai", "mango pickle", "lemon pickle"], 190, 1.0, 5.0, 18, 2.0, 2.0, 2500, {"tsp": 5, "tbsp": 15}, "tsp"),
    "Papad": _f(["papad", "appalam", "pappadam", "papadum"], 370, 25, 60, 3.0, 10, 1.0, 1500, {"piece": 12}),
    "Idli podi": _f(["podi", "idli podi", "gunpowder", "milagai podi"], 400, 18, 45, 15, 12, 2.0, 800, {"tsp": 5, "tbsp": 12}, "tbsp"),
    "Samosa": _f(["samosa", "samsa"], 310, 5.0, 32, 18, 3.0, 2.0, 450, {"piece": 80}),
    "Pakora / bajji": _f(["pakora", "pakoda", "bajji", "bhajji", "bhaji", "onion pakoda"], 290, 6.0, 28, 17, 3.0, 2.0, 400, {"piece": 25, "plate": 150, "cup": 100}),
    "Bonda": _f(["bonda", "aloo bonda", "mysore bonda"], 280, 5.0, 32, 15, 2.0, 1.5, 400, {"piece": 45}),
    "Masala vada": _f(["masala vada", "paruppu vadai", "dal vada"], 300, 11, 30, 16, 5.0, 1.0, 400, {"piece": 40}),
    "Pani puri": _f(["pani puri", "golgappa", "puchka", "gol gappa"], 180, 3.5, 30, 5.0, 2.5, 3.0, 450, {"piece": 20, "plate": 120}, "piece"),
    "Bhel / sev puri": _f(["bhel", "bhel puri", "sev puri", "masala puri", "chaat", "dahi puri"], 180, 4.0, 28, 6.0, 2.5, 4.0, 500, {"cup": 100, "plate": 150}, "plate"),
    "Pav bhaji": _f(["pav bhaji", "pao bhaji"], 180, 4.5, 25, 7.0, 3.0, 3.0, 500, {"plate": 300, "piece": 150}, "plate"),
    "Vada pav": _f(["vada pav", "vada pao", "wada pav"], 290, 6.5, 40, 12, 2.5, 3.0, 550, {"piece": 140}),
    "Dhokla": _f(["dhokla", "khaman"], 160, 6.0, 25, 4.0, 2.0, 5.0, 450, {"piece": 30, "plate": 150}),
    "Veg momos": _f(["momo", "veg momo", "dumpling"], 160, 6.0, 25, 4.0, 2.0, 1.5, 400, {"piece": 30, "plate": 180}),
    "Chicken momos": _f(["chicken momo", "chicken dumpling"], 190, 10, 22, 7.0, 1.0, 1.0, 450, {"piece": 30, "plate": 180}),
    "Gobi manchurian": _f(["gobi manchurian", "manchurian", "cauliflower fry", "gobi fry", "gobi sixtyfive", "paneer sixtyfive", "mushroom sixtyfive"], 190, 4.0, 22, 10, 3.0, 5.0, 600, {"plate": 200, "cup": 150}, "serving"),
    "Murukku / mixture": _f(["murukku", "chakli", "mixture", "namkeen", "bhujia", "chips", "banana chips"], 530, 9.0, 52, 32, 4.0, 3.0, 700, {"piece": 15, "handful": 30, "cup": 60}, "handful"),
    "Biscuits": _f(["biscuit", "cookie", "marie", "marie biscuit", "good day"], 460, 7.0, 70, 16, 2.0, 22, 350, {"piece": 8}),
    "Gulab jamun": _f(["gulab jamun", "jamun"], 330, 5.0, 50, 13, 0.5, 40, 50, {"piece": 40}),
    "Rasgulla": _f(["rasgulla", "rasagolla", "rosogolla", "rasmalai"], 186, 4.0, 40, 1.8, 0, 37, 30, {"piece": 45}),
    "Jalebi": _f(["jalebi", "jilebi", "jangiri"], 380, 3.0, 60, 15, 0.5, 45, 20, {"piece": 30}),
    "Laddu": _f(["laddu", "ladoo", "besan laddu", "boondi laddu", "rava laddu"], 450, 7.0, 55, 23, 2.0, 38, 50, {"piece": 40}),
    "Mysore pak / barfi": _f(["mysore pak", "barfi", "burfi", "kaju katli", "peda"], 480, 8.0, 52, 27, 1.0, 38, 50, {"piece": 25}),
    "Kheer / payasam": _f(["kheer", "payasam", "payasa", "semiya payasam", "pal payasam"], 150, 4.0, 22, 5.0, 0.5, 16, 50, {"cup": 150, "bowl": 150}, "cup"),
    "Kesari / halwa": _f(["kesari", "rava kesari", "halwa", "sooji halwa", "sheera", "gajar halwa"], 330, 3.5, 48, 14, 1.0, 30, 50, {"cup": 150, "bowl": 150, "piece": 60}, "serving"),
    "Lassi": _f(["lassi", "sweet lassi", "mango lassi"], 90, 3.0, 14, 2.5, 0, 13, 50, {"glass": 250, "cup": 200}, "glass"),
    "Badam milk": _f(["badam milk", "almond milk shake", "rose milk", "milkshake", "milk shake"], 110, 4.0, 14, 4.5, 0.3, 12, 50, {"glass": 250, "cup": 200}, "glass"),
    "Malt drink with milk": _f(["horlicks", "boost", "bournvita", "complan", "malt"], 80, 3.5, 11, 2.5, 0.3, 9.0, 60, {"glass": 250, "cup": 200}, "glass"),
    "Fresh fruit juice": _f(["juice", "orange juice", "mosambi juice", "sweet lime juice", "fruit juice", "watermelon juice"], 45, 0.6, 10.5, 0.2, 0.2, 9.0, 2, {"glass": 250, "cup": 200}, "glass"),
    "Sugarcane juice": _f(["sugarcane juice", "ganne ka ras", "karumbu juice"], 70, 0.2, 17, 0, 0, 16, 10, {"glass": 250}, "glass"),
    "Sweet corn": _f(["corn", "sweet corn", "bhutta", "corn cob"], 96, 3.4, 21, 1.5, 2.4, 4.5, 15, {"cup": 150, "piece": 100}, "cup"),
    "Guava": _f(["guava", "koyya", "amrood"], 68, 2.6, 14, 1.0, 5.4, 9.0, 2, {"piece": 100}),
    "Papaya": _f(["papaya"], 43, 0.5, 11, 0.3, 1.7, 8.0, 8, {"cup": 145, "piece": 150, "bowl": 200}, "cup"),
    "Mango": _f(["mango"], 60, 0.8, 15, 0.4, 1.6, 14, 1, {"piece": 200, "cup": 165}),
    "Watermelon": _f(["watermelon"], 30, 0.6, 7.6, 0.2, 0.4, 6.2, 1, {"cup": 150, "slice": 280, "bowl": 200}, "cup"),
    "Grapes": _f(["grape"], 69, 0.7, 18, 0.2, 0.9, 15.5, 2, {"cup": 150, "handful": 50}, "cup"),
    "Pomegranate": _f(["pomegranate", "anar", "mathulai"], 83, 1.7, 19, 1.2, 4.0, 14, 3, {"cup": 175, "piece": 280}, "cup"),
}

# Extra dictionary words used for typo correction (not food names on their own).
_EXTRA_VOCAB = {"sandwich", "masala", "curry", "gravy", "fry", "roast", "tikka", "grilled", "boiled", "fried", "roll", "rice", "chicken", "paneer"}

# Grams per unit when the food doesn't define its own.
DEFAULT_UNIT_G = {
    "piece": 50, "cup": 150, "bowl": 200, "plate": 250, "scoop": 30, "slice": 30,
    "tbsp": 15, "tsp": 5, "glass": 250, "serving": 100, "handful": 30,
}

UNIT_ALIASES = {
    "g": "g", "gm": "g", "gms": "g", "gr": "g", "gram": "g", "gramme": "g",
    "kg": "kg", "kilo": "kg", "kilogram": "kg",
    "ml": "ml", "millilitre": "ml", "milliliter": "ml",
    "l": "l", "ltr": "l", "litre": "l", "liter": "l",
    "cup": "cup", "cut": "cup", "katori": "cup", "tumbler": "cup", "mug": "cup",
    "bowl": "bowl", "plate": "plate", "scoop": "scoop", "slice": "slice",
    "piece": "piece", "pc": "piece", "pcs": "piece", "nos": "piece", "number": "piece",
    "tbsp": "tbsp", "tablespoon": "tbsp", "spoon": "tbsp",
    "tsp": "tsp", "teaspoon": "tsp",
    "glass": "glass", "serving": "serving", "portion": "serving", "handful": "handful",
}

WORD_NUMBERS = {
    "a": 1, "an": 1, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6,
    "seven": 7, "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12,
    "dozen": 12, "half": 0.5, "quarter": 0.25, "couple": 2, "few": 3,
}

FILLERS = re.compile(
    r"\b(i\s+have\s+had|i've\s+had|i\s+had|i\s+ate|i\s+took|i\s+drank|i\s+have|"
    r"had|ate|took|drank|eaten|consumed|today|tonight|this\s+morning|"
    r"in\s+the\s+(morning|evening|afternoon|night)|for\s+(breakfast|lunch|dinner|snacks?|brunch)|"
    r"as\s+(breakfast|lunch|dinner|snacks?)|breakfast|lunch|dinner|also|just|around|about|"
    r"approx(imately)?|nearly|some|of|x|i|ve|we|me|my|only|morning|evening|night)\b"
)
SPLITTER = re.compile(r"\s*(,|;|\n|\+|&|\balong\s+with\b|\band\b|\bwith\b|\bplus\b|\bthen\b)\s*")
QTY_RE = r"(\d+(?:\.\d+)?(?:/\d+)?)"
# Common regional spellings, applied to both aliases and input.
_SPELLINGS = {
    "dosai": "dosa", "dose": "dosa", "vadai": "vada", "wada": "vada", "idly": "idli",
    "briyani": "biryani", "biriyani": "biryani", "biriani": "biryani", "chapathi": "chapati",
    "chappathi": "chapati", "chapatti": "chapati", "poori": "puri", "parota": "parotta",
    "porotta": "parotta", "barotta": "parotta", "sambhar": "sambar", "sambaar": "sambar",
    "pakoda": "pakora", "bajji": "bhajji", "ladoo": "laddu", "burfi": "barfi", "dhal": "dal",
    "daal": "dal", "panir": "paneer", "omlet": "omelette", "omelet": "omelette",
}
# "coffee with milk" — an un-quantified add-in is already part of the drink.
ADD_INS = {"milk", "sugar", "jaggery", "ice", "water", "no sugar", "less sugar", "without sugar"}


def _singular(word: str) -> str:
    if len(word) <= 3 or word.endswith("ss"):
        return word
    if word.endswith(("sses", "shes", "ches", "xes")):
        return word[:-2]
    if word.endswith("ies"):
        return word[:-3] + "y"
    if word.endswith("oes"):
        return word[:-2]
    if word.endswith("s"):
        return word[:-1]
    return word


def _norm(text: str) -> str:
    words = (_singular(w) for w in re.findall(r"[a-z]+", text.lower()))
    return " ".join(_SPELLINGS.get(w, w) for w in words)


_ALIAS_INDEX = sorted(
    ((_norm(a), name) for name, food in FOODS.items() for a in food["aliases"]),
    key=lambda x: -len(x[0]),
)
_VOCAB = sorted({w for a, _ in _ALIAS_INDEX for w in a.split()} | _EXTRA_VOCAB)
_INGREDIENTS = {
    "Carrot", "Cucumber", "Tomato", "Onion", "Beetroot", "Potato (boiled)", "Sweet potato",
    "Paneer", "Chicken breast (cooked)", "Whole egg", "Milk", "Sugar", "Ghee", "Butter",
}


def _correct(item: str) -> str:
    """Fix spelling against known food words: "panner sanwitch" -> "paneer sandwich"."""
    out = []
    for w in _norm(item).split():
        if len(w) >= 4 and w not in _VOCAB:
            close = difflib.get_close_matches(w, _VOCAB, n=1, cutoff=0.75)
            w = close[0] if close else w
        out.append(w)
    return " ".join(out)


def _to_number(tok: str) -> float:
    if "/" in tok:
        a, b = tok.split("/", 1)
        return float(a) / float(b) if float(b) else 1.0
    return float(tok)


# ------------------------------------------------------------------ parsing


def parse_text(text: str) -> list[dict[str, Any]]:
    """Split free text into [{qty, unit, item}] entries."""
    t = text.lower()
    t = re.sub(
        r"\b(\d+|a|one|two|three|four|five)\s+and\s+(?:a\s+)?half\b",
        lambda m: str((int(m.group(1)) if m.group(1).isdigit() else WORD_NUMBERS[m.group(1)]) + 0.5),
        t,
    )
    t = re.sub(r"\b(\d+)\s*-\s*(\d+)\b", r"\2", t)  # "2-3 idli" -> upper bound
    t = re.sub(r"\b(chicken|gobi|paneer|mushroom)\s*-?\s*65\b", r"\1 sixtyfive", t)

    parts_ = SPLITTER.split(t)
    chunks = [(parts_[0], None)] + [
        (parts_[i + 1], parts_[i].strip()) for i in range(1, len(parts_) - 1, 2)
    ]

    items = []
    for chunk, sep in chunks:
        chunk = re.sub(r"[^a-z0-9./\s]", " ", chunk)
        chunk = FILLERS.sub(" ", chunk)
        words = chunk.split()
        # "a"/"an" only count as 1 when they lead the phrase.
        words = [
            str(WORD_NUMBERS[w]) if w in WORD_NUMBERS and (i == 0 or w not in ("a", "an")) else w
            for i, w in enumerate(words)
        ]
        chunk = re.sub(r"(\d)([a-z])", r"\1 \2", " ".join(words))  # 200g -> 200 g
        chunk = " ".join(chunk.split())
        if not chunk:
            continue
        if sep == "with" and not re.search(r"\d", chunk) and _norm(chunk) in ADD_INS:
            continue

        qty, unit, item = None, None, chunk
        m = re.match(rf"^{QTY_RE}\s*(.*)$", chunk)
        if m:
            qty, item = _to_number(m.group(1)), m.group(2)
        else:
            m = re.match(rf"^(.*?)\s+{QTY_RE}\s*([a-z]*)$", chunk)
            if m:
                item, qty = m.group(1), _to_number(m.group(2))
                if m.group(3):
                    item = f"{m.group(3)} {item}"  # push unit to front for handling below

        parts = item.split()
        if parts and _singular(parts[0]) in UNIT_ALIASES:
            unit = UNIT_ALIASES[_singular(parts[0])]
            parts = parts[1:]
        # Qty may follow the unit word: "cup 2 rice" is rare; ignore.
        item = " ".join(p for p in parts if not re.fullmatch(QTY_RE, p)).strip()
        if not item:
            continue
        items.append({"qty": qty if qty is not None else 1.0, "unit": unit, "item": item})
    return items


# ------------------------------------------------------------------ lookup


def _local_match(item: str) -> str | None:
    n = f" {_norm(item)} "
    matches = [name for alias, name in _ALIAS_INDEX if f" {alias} " in n]
    # A dish word ("poriyal", "halwa") beats a raw ingredient ("beetroot", "carrot").
    dishes = [m for m in matches if m not in _INGREDIENTS]
    return next(iter(dishes or matches), None)


def _rank(query: str, name: str) -> tuple:
    """Sort key: prefer names whose first segment is just the query ("Avocados, raw")."""
    q_words = set(_norm(query).split())
    desc = name.lower()
    head = set(_norm(desc.split(",")[0]).split())
    return (len(head - q_words), len(q_words - set(_norm(desc).split())), desc.count(","))


def _usda_lookup(query: str) -> dict[str, Any] | None:
    foods = None
    for attempt in range(3):  # the FDC gateway returns sporadic 400s
        try:
            r = requests.get(
                USDA_URL,
                params={
                    "query": query,
                    "pageSize": "25",
                    "dataType": ["Survey (FNDDS)", "Foundation", "SR Legacy"],
                    "api_key": USDA_KEY,
                },
                headers=HTTP_HEADERS,
                timeout=8,
            )
            if r.status_code == 429:
                logger.info("USDA rate limit hit (set USDA_FDC_API_KEY for a higher quota)")
                return None
            r.raise_for_status()
            foods = r.json().get("foods") or []
            break
        except Exception as exc:  # noqa: BLE001
            logger.info("USDA lookup attempt %d failed for %r: %s", attempt + 1, query, exc)
    if foods is None:
        return None

    ids = {"208": "kcal", "203": "protein", "205": "carbs", "204": "fat",
           "291": "fiber", "269": "sugar", "307": "sodium"}
    for food in sorted(foods, key=lambda f: _rank(query, f.get("description") or "")):
        per100 = {k: 0.0 for k in NUTRIENTS}
        found_kcal = False
        for fn in food.get("foodNutrients") or []:
            num = str(fn.get("nutrientNumber") or "")
            val = fn.get("value")
            if val is None:
                continue
            if num in ids:
                per100[ids[num]] = float(val)
                found_kcal = found_kcal or num == "208"
            elif num in ("957", "958") and not found_kcal:  # Atwater energy
                per100["kcal"] = float(val)
                found_kcal = True
        if not found_kcal:
            continue
        measures = {}
        piece_rank = 99
        for m in food.get("foodMeasures") or []:
            text = (m.get("disseminationText") or "").lower()
            grams = m.get("gramWeight")
            if not grams:
                continue
            words = re.findall(r"[a-z]+", text)
            # Whole-item portions beat "1 slice or piece" style fragments.
            rank = next((r for r, w in enumerate(("medium", "whole", "fruit", "each", "item", "large", "small", "piece")) if w in words), None)
            if rank is not None and rank < piece_rank:
                measures["piece"], piece_rank = grams, rank
            for word in words:
                unit = UNIT_ALIASES.get(_singular(word))
                if unit and unit != "piece" and unit not in measures:
                    measures[unit] = grams
            if "not specified" in text:
                measures["_first"] = grams
            measures.setdefault("_first", grams)
        return {
            "name": str(food.get("description") or query).capitalize(),
            "source": "USDA FoodData Central",
            "per100": per100,
            "units": measures,
        }
    return None


def _off_lookup(query: str) -> dict[str, Any] | None:
    products: list[dict[str, Any]] = []
    # Indian products first, then worldwide.
    for country in ({"tagtype_0": "countries", "tag_contains_0": "contains", "tag_0": "india"}, {}):
        try:
            r = requests.get(
                OFF_URL,
                params={
                    "search_terms": query,
                    "search_simple": "1",
                    "action": "process",
                    "json": "1",
                    "page_size": "10",
                    "fields": "product_name,nutriments,serving_quantity",
                    **country,
                },
                headers=HTTP_HEADERS,
                timeout=8,
            )
            r.raise_for_status()
            products = [p for p in r.json().get("products") or [] if (p.get("nutriments") or {}).get("energy-kcal_100g") is not None]
        except Exception as exc:  # noqa: BLE001
            logger.info("Open Food Facts lookup failed for %r: %s", query, exc)
        if products:
            break
    if not products:
        return None

    for p in sorted(products, key=lambda p: _rank(query, p.get("product_name") or "")):
        n = p.get("nutriments") or {}
        kcal = n.get("energy-kcal_100g")
        if kcal is None:
            continue
        per100 = {
            "kcal": float(kcal),
            "protein": float(n.get("proteins_100g") or 0),
            "carbs": float(n.get("carbohydrates_100g") or 0),
            "fat": float(n.get("fat_100g") or 0),
            "fiber": float(n.get("fiber_100g") or 0),
            "sugar": float(n.get("sugars_100g") or 0),
            "sodium": float(n.get("sodium_100g") or 0) * 1000,
        }
        serving = p.get("serving_quantity")
        units = {"_first": float(serving)} if serving and float(serving) >= 5 else {}
        return {
            "name": p.get("product_name") or query,
            "source": "Open Food Facts",
            "per100": per100,
            "units": units,
        }
    return None


def _lookup(item: str) -> dict[str, Any] | None:
    corrected = _correct(item)
    local = _local_match(corrected)
    if local:
        food = FOODS[local]
        return {"name": local, "source": "Built-in table", "per100": food["per100"],
                "units": food["units"], "default": food["default"], "query": corrected}
    item = corrected
    key = _norm(item)
    with _LOCK:
        if not _LOOKUP_CACHE and CACHE_FILE.exists():
            try:
                _LOOKUP_CACHE.update(json.loads(CACHE_FILE.read_text(encoding="utf-8")))
            except Exception:  # noqa: BLE001
                pass
        if key in _LOOKUP_CACHE:
            return _LOOKUP_CACHE[key]
    found = _usda_lookup(item) or _off_lookup(item)
    if found:  # misses aren't cached so they can be retried later
        found["query"] = item
        with _LOCK:
            _LOOKUP_CACHE[key] = found
            DATA_DIR.mkdir(parents=True, exist_ok=True)
            CACHE_FILE.write_text(json.dumps(_LOOKUP_CACHE), encoding="utf-8")
    return found


def _grams(qty: float, unit: str | None, food: dict[str, Any]) -> float:
    if unit == "g":
        return qty
    if unit == "kg":
        return qty * 1000
    if unit == "ml":
        return qty
    if unit == "l":
        return qty * 1000
    units = food.get("units") or {}
    if unit:
        return qty * (units.get(unit) or DEFAULT_UNIT_G.get(unit, 100))
    default = food.get("default")
    if default:
        return qty * (units.get(default) or DEFAULT_UNIT_G.get(default, 100))
    return qty * (units.get("piece") or units.get("_first") or 100)


def analyse(text: str) -> list[dict[str, Any]]:
    out = []
    for p in parse_text(text):
        food = _lookup(p["item"])
        if not food:
            out.append({"input": p["item"], "name": p["item"], "qty": p["qty"], "unit": p["unit"],
                        "grams": None, "source": None, "found": False,
                        **{k: 0 for k in NUTRIENTS}})
            continue
        grams = _grams(p["qty"], p["unit"], food)
        factor = grams / 100
        unit = p["unit"] or food.get("default") or ("piece" if "piece" in food["units"] else "serving")
        query = food.get("query") or ""
        out.append({
            "input": p["item"],
            "readAs": query if query and query != _norm(p["item"]) else None,
            "name": food["name"],
            "qty": p["qty"],
            "unit": unit,
            "grams": round(grams),
            "source": food["source"],
            "found": True,
            **{k: round(food["per100"][k] * factor, 1) for k in NUTRIENTS},
        })
    return out


def _sum(items: list[dict[str, Any]]) -> dict[str, float]:
    return {k: round(sum(i.get(k) or 0 for i in items), 1) for k in NUTRIENTS}


# ------------------------------------------------------------------ storage


def _load() -> dict[str, Any]:
    if not LOG_FILE.exists():
        return {"entries": [], "days": {}}
    try:
        data = json.loads(LOG_FILE.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        logger.warning("Could not read nutrition log: %s", exc)
        return {"entries": [], "days": {}}
    data.setdefault("entries", [])
    data.setdefault("days", {})
    return data


def _save(data: dict[str, Any]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = LOG_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=1), encoding="utf-8")
    tmp.replace(LOG_FILE)


def add_entry(text: str, date: str) -> dict[str, Any]:
    items = analyse(text)
    entry = {
        "id": uuid.uuid4().hex,
        "date": date,
        "time": dt.datetime.now().strftime("%H:%M"),
        "text": text.strip(),
        "items": items,
        "totals": _sum(items),
    }
    with _LOCK:
        data = _load()
        data["entries"].append(entry)
        _save(data)
    return entry


def set_revoked(entry_id: str, revoked: bool, item: int | None = None) -> dict[str, Any] | None:
    """Revoke/restore a whole entry or one of its items; kept on disk for history."""
    with _LOCK:
        data = _load()
        entry = next((e for e in data["entries"] if e.get("id") == entry_id), None)
        if entry is None:
            return None
        if item is None:
            entry["revoked"] = revoked
        else:
            if not 0 <= item < len(entry["items"]):
                return None
            entry["items"][item]["revoked"] = revoked
            entry["totals"] = _sum([i for i in entry["items"] if not i.get("revoked")])
        entry["revokedAt" if revoked else "restoredAt"] = dt.datetime.now().isoformat(timespec="seconds")
        _save(data)
    return entry


def set_item_qty(entry_id: str, item: int, qty: float) -> dict[str, Any] | None:
    """Change one item's quantity, scaling its grams and nutrients proportionally."""
    with _LOCK:
        data = _load()
        entry = next((e for e in data["entries"] if e.get("id") == entry_id), None)
        if entry is None or not 0 <= item < len(entry["items"]):
            return None
        it = entry["items"][item]
        old = it.get("qty") or 0
        if not it.get("found") or old <= 0:
            return None
        factor = qty / old
        it["qty"] = qty
        if it.get("grams") is not None:
            it["grams"] = round(it["grams"] * factor)
        for k in NUTRIENTS:
            it[k] = round((it.get(k) or 0) * factor, 1)
        entry["totals"] = _sum([i for i in entry["items"] if not i.get("revoked")])
        entry["editedAt"] = dt.datetime.now().isoformat(timespec="seconds")
        _save(data)
    return entry


def reanalyse_entry(entry_id: str) -> dict[str, Any] | None:
    with _LOCK:
        entry = next((e for e in _load()["entries"] if e.get("id") == entry_id), None)
    if entry is None:
        return None
    items = analyse(entry["text"])  # network lookups happen outside the lock
    with _LOCK:
        data = _load()
        entry = next((e for e in data["entries"] if e.get("id") == entry_id), None)
        if entry is None:
            return None
        entry["items"] = items
        entry["totals"] = _sum(items)
        _save(data)
    return entry


def entries_for(date: str) -> list[dict[str, Any]]:
    return [e for e in _load()["entries"] if e.get("date") == date]


def _active(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [e for e in entries if not e.get("revoked")]


def save_day_snapshot(date: str, snapshot: dict[str, Any]) -> None:
    with _LOCK:
        data = _load()
        data["days"][date] = snapshot
        _save(data)


def history(days: int) -> list[dict[str, Any]]:
    data = _load()
    start = (dt.date.today() - dt.timedelta(days=days - 1)).isoformat()
    by_day: dict[str, list[dict[str, Any]]] = {}
    for e in _active(data["entries"]):
        if e.get("date", "") >= start:
            by_day.setdefault(e["date"], []).append(e)
    out = []
    for date in sorted(by_day):
        snap = data["days"].get(date) or {}
        foods: dict[tuple, dict[str, Any]] = {}
        for e in by_day[date]:
            for i in e["items"]:
                if not i.get("found") or i.get("revoked"):
                    continue
                f = foods.setdefault((i["name"], i["unit"]), {"name": i["name"], "unit": i["unit"], "qty": 0, "grams": 0, **{k: 0 for k in NUTRIENTS}})
                f["qty"] = round(f["qty"] + (i.get("qty") or 0), 2)
                f["grams"] = round(f["grams"] + (i.get("grams") or 0))
                for k in NUTRIENTS:
                    f[k] = round(f[k] + (i.get(k) or 0), 1)
        out.append({
            "date": date,
            "intake": _sum([e["totals"] for e in by_day[date]]),
            "entries": len(by_day[date]),
            "items": sorted(foods.values(), key=lambda f: -f["kcal"]),
            "burn": snap.get("burn"),
            "targetKcal": (snap.get("targets") or {}).get("kcal"),
            "status": snap.get("status"),
        })
    return out


# --------------------------------------------------------------- assessment

DEFAULT_WEIGHT_KG = float(os.environ.get("NUTRITION_BODY_WEIGHT_KG", "70"))
DEFAULT_BMR = float(os.environ.get("NUTRITION_BMR_KCAL", "1650"))


def _estimate_workout_kcal(w: dict[str, Any], weight: float) -> float:
    if w.get("kcal"):
        return float(w["kcal"])
    if w.get("type") in ("running", "trail_running", "treadmill_running", "walking", "hiking") and w.get("distanceKm"):
        return (w["distanceKm"] or 0) * weight * (1.0 if "run" in (w.get("type") or "") else 0.6)
    return (w.get("minutes") or 0) * 7


def assess(date: str, energy: dict[str, Any]) -> dict[str, Any]:
    """Compare the day's intake with burn/workout and give suggestions."""
    entries = entries_for(date)
    intake = _sum([e["totals"] for e in _active(entries)])
    weight = energy.get("weightKg") or DEFAULT_WEIGHT_KG
    workouts = [
        {**w, "kcal": round(_estimate_workout_kcal(w, weight)), "estimated": not w.get("kcal")}
        for w in energy.get("workouts") or []
    ]
    workout_kcal = sum(w["kcal"] for w in workouts)
    workout_min = sum(w.get("minutes") or 0 for w in workouts)

    bmr = energy.get("bmr") or DEFAULT_BMR
    active = energy.get("active")
    # Garmin active kcal already includes workouts + steps; otherwise add a
    # light-lifestyle allowance (~20% of BMR) on top of workouts.
    burn_active = max(active or 0, workout_kcal) if active is not None else workout_kcal + 0.2 * bmr
    burn = round(bmr + burn_active)

    protein_per_kg = 1.8 if workout_kcal >= 500 else 1.6 if workouts else 1.4
    carbs_per_kg = 3 if workout_min < 30 else 5 if workout_min < 75 else 6 if workout_min < 150 else 7
    targets = {
        "kcal": burn,
        "protein": round(protein_per_kg * weight),
        "carbs": round(carbs_per_kg * weight),
        "fat": round(0.27 * burn / 9),
        "fiber": round(14 * burn / 1000),
        "sugar": round(0.10 * burn / 4),
        "sodium": 2300,
    }

    ratio = intake["kcal"] / burn if burn else 0
    is_today = date == dt.date.today().isoformat()
    if ratio < 0.85:
        status = "low"
    elif ratio > 1.10:
        status = "high"
    else:
        status = "in_limit"

    tips = _suggestions(intake, targets, status, workout_kcal, workout_min, is_today)

    result = {
        "date": date,
        "entries": entries,
        "intake": intake,
        "targets": targets,
        "burn": {"bmr": round(bmr), "active": round(burn_active), "workoutKcal": workout_kcal,
                 "workoutMin": workout_min, "total": burn, "source": energy.get("source") or "estimate"},
        "workouts": workouts,
        "weightKg": weight,
        "balance": round(intake["kcal"] - burn),
        "status": status,
        "suggestions": tips,
        "inProgress": is_today,
    }
    if entries:
        save_day_snapshot(date, {k: result[k] for k in ("intake", "targets", "burn", "status", "weightKg")})
    return result


def _suggestions(intake, targets, status, workout_kcal, workout_min, is_today) -> list[str]:
    tips: list[str] = []
    gap = targets["kcal"] - intake["kcal"]
    if status == "low":
        if is_today:
            extra = f" (incl. {workout_kcal} kcal of workouts)" if workout_kcal else ""
            tips.append(f"~{round(gap)} kcal left to match today's burn{extra}. Spread it over balanced meals — don't skip post-workout refuelling.")
        elif workout_kcal >= 400:
            tips.append(f"You were ~{round(gap)} kcal short after a {workout_kcal} kcal workout — under-fuelling hurts recovery (add rice/idli + dal, banana, curd).")
        else:
            tips.append(f"Intake was ~{round(gap)} kcal below burn. A small deficit is fine for fat loss; large ones hurt training quality.")
    elif status == "high":
        tips.append(f"~{round(-gap)} kcal above today's burn. Keep the next meal light (salad, dal, lean protein) or add an easy walk.")
    else:
        tips.append("Calories are well matched to your burn today. 👍")

    p_gap = targets["protein"] - intake["protein"]
    if p_gap > 10:
        tips.append(f"Protein is {round(p_gap)} g below target ({targets['protein']} g). Options: 1 scoop whey (~25 g), 3 eggs (~19 g), 100 g paneer (~18 g), 150 g chicken breast (~46 g) or 1 cup chana (~14 g).")
    elif intake["protein"] > targets["protein"] * 1.5:
        tips.append("Protein is well above target — fine occasionally, but balance with carbs and veggies.")

    c_gap = targets["carbs"] - intake["carbs"]
    if workout_min >= 60 and c_gap > 50:
        tips.append(f"Long session today ({workout_min} min) — carbs are {round(c_gap)} g short. Add rice, idli, oats, potatoes or fruit to refill glycogen.")

    if intake["fat"] > targets["fat"] * 1.2:
        tips.append(f"Fat is high ({round(intake['fat'])} g vs ~{targets['fat']} g). Go easy on ghee, fried items and parotta.")
    if intake["fiber"] < targets["fiber"] * 0.6 and intake["kcal"] > 800:
        tips.append(f"Fiber is low ({round(intake['fiber'])} g vs {targets['fiber']} g). Add vegetables, fruit, sprouts or dal.")
    if intake["sugar"] > targets["sugar"]:
        tips.append(f"Sugar is above ~10% of calories ({round(intake['sugar'])} g). Cut back on sweet drinks and desserts.")
    if intake["sodium"] > targets["sodium"]:
        tips.append(f"Sodium is high ({round(intake['sodium'])} mg). Drink water; fine if you sweated a lot today.")
    return tips
