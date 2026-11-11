-- Wieczorem: zamyka rolety i gasi swiatlo (wywolywany przez TIMER_ROLETY)
if PARTER->CZUJNIK_OKNO_SALON->Value == 0 then
  PARTER->ROLETA_SALON->MoveDown(0)
  PARTER->ROLETA_KUCHNIA->MoveDown(0)
end
PARTER->LAMPA_SALON->SwitchOff(0)
print(PIETRO->LAMPA_SYPIALNIA->Value)
